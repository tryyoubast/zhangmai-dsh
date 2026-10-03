from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

from .errors import AuthoringApiError


class AuthoringTransport(Protocol):
    """Small HTTP seam used by the authoring client and deterministic tests."""

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> tuple[int, dict[str, str], bytes]: ...


class UrllibAuthoringTransport:
    """stdlib HTTP transport; credentials are only sent in request bodies/headers."""

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> tuple[int, dict[str, str], bytes]:
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.status, dict(response.headers.items()), response.read()
        except HTTPError as error:
            return error.code, dict(error.headers.items()), error.read()
        except URLError as error:
            raise AuthoringApiError(503, "transport_unavailable") from error


@dataclass(frozen=True, slots=True)
class AuthoringClientConfig:
    """Remote base URL and bounded request timeout for the official client."""

    base_url: str
    timeout_seconds: float = 30.0

    def __post_init__(self) -> None:
        parsed = urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an absolute http or https URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("base_url must not contain credentials")
        if parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain a query or fragment")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")


@dataclass(frozen=True, slots=True)
class AuthoringAuthState:
    """In-memory official-client credentials; raw tokens are never serialized by the SDK."""

    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    workspace_id: str | None
    roles: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class WorkspaceInfo:
    """Server-provided workspace projection used for safe client-side selection."""

    workspace_id: str
    name: str
    status: str | None = None
    role: str | None = None


class AuthoringClient:
    """Official-client API for login, workspace selection, and draft authoring."""

    def __init__(self, config: AuthoringClientConfig, *, transport: AuthoringTransport | None = None) -> None:
        self.config = config
        self._transport = transport or UrllibAuthoringTransport()
        self._state: AuthoringAuthState | None = None
        self._workspaces: tuple[WorkspaceInfo, ...] = ()

    @property
    def auth_state(self) -> AuthoringAuthState | None:
        return self._state

    def login(self, email: str, password: str, *, workspace_id: str | None = None) -> AuthoringAuthState:
        if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password:
            raise ValueError("email and password are required")
        value = self._request("POST", "/auth/login", {"email": email, "password": password, "clientType": "official-client"}, authenticated=False)
        state = self._state_from_response(value, workspace_id=workspace_id)
        self._state = state
        self._workspaces = ()
        return state

    def refresh(self) -> AuthoringAuthState:
        state = self._state
        if state is None:
            raise AuthoringApiError(401, "unauthorized")
        value = self._request("POST", "/auth/refresh", {"refreshToken": state.refresh_token}, authenticated=False)
        replacement = self._state_from_response(value, workspace_id=state.workspace_id, roles=state.roles)
        self._state = replacement
        return replacement

    def logout(self) -> None:
        """Revoke the remote session and always erase local credentials."""
        try:
            if self._state is not None:
                self._request("POST", "/auth/logout", None)
        finally:
            self._state = None
            self._workspaces = ()

    def list_workspaces(self) -> tuple[WorkspaceInfo, ...]:
        """List workspaces visible to the authenticated principal."""
        if self._state is None:
            raise AuthoringApiError(401, "unauthorized")
        value = self._request("GET", "/workspaces", None)
        raw_workspaces = value.get("workspaces")
        if not isinstance(raw_workspaces, list):
            raise AuthoringApiError(502, "invalid_workspace_response")
        workspaces: list[WorkspaceInfo] = []
        for raw in raw_workspaces:
            if not isinstance(raw, dict):
                raise AuthoringApiError(502, "invalid_workspace_response")
            workspace_id = raw.get("workspaceId", raw.get("id"))
            if not isinstance(workspace_id, str) or not workspace_id.strip():
                raise AuthoringApiError(502, "invalid_workspace_response")
            name = raw.get("name")
            status = raw.get("status")
            role = raw.get("role")
            workspaces.append(WorkspaceInfo(
                workspace_id=workspace_id,
                name=name if isinstance(name, str) else "",
                status=status if isinstance(status, str) else None,
                role=role if isinstance(role, str) else None,
            ))
        self._workspaces = tuple(workspaces)
        return self._workspaces

    def switch_workspace(self, workspace_id: str) -> WorkspaceInfo:
        """Select only a workspace returned by the server's membership list.

        This method does not grant access.  The host still resolves the selected
        workspace against the authenticated principal and enforces RLS.
        """
        if self._state is None:
            raise AuthoringApiError(401, "unauthorized")
        if not isinstance(workspace_id, str) or not workspace_id.strip():
            raise ValueError("workspace_id is required")
        workspaces = self._workspaces or self.list_workspaces()
        for workspace in workspaces:
            if workspace.workspace_id == workspace_id:
                self._state = AuthoringAuthState(self._state.access_token, self._state.refresh_token, workspace_id, self._state.roles)
                return workspace
        raise AuthoringApiError(403, "workspace_forbidden")

    def generate_draft(self, novel_id: str, instruction: str, *, idempotency_key: str, limit: int = 8) -> dict[str, object]:
        if (
            not isinstance(novel_id, str) or not novel_id.strip()
            or not isinstance(instruction, str) or not instruction.strip()
            or not isinstance(idempotency_key, str) or not idempotency_key.strip()
        ):
            raise ValueError("novel_id, instruction, and idempotency_key are required")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
            raise ValueError("limit must be non-negative")
        value = self._request("POST", f"/novels/{novel_id}/generate", {
            "workspaceId": self._workspace(),
            "instruction": instruction,
            "idempotencyKey": idempotency_key,
            "limit": limit,
        })
        return value

    def review_proposal(self, proposal_id: str, decision: str) -> dict[str, object]:
        if (
            not isinstance(proposal_id, str) or not proposal_id.strip()
            or not isinstance(decision, str)
            or decision not in {"approved", "rejected", "expired", "draft"}
        ):
            raise ValueError("decision is invalid")
        return self._request("POST", f"/proposals/{proposal_id}/review", {"decision": decision})

    def publish_proposal(self, proposal_id: str) -> dict[str, object]:
        if not isinstance(proposal_id, str) or not proposal_id.strip():
            raise ValueError("proposal_id is required")
        return self._request("POST", f"/proposals/{proposal_id}/publish", {})

    def _workspace(self) -> str:
        if self._state is None or self._state.workspace_id is None:
            raise AuthoringApiError(409, "workspace_required")
        return self._state.workspace_id

    def _state_from_response(self, value: dict[str, object], *, workspace_id: str | None, roles: tuple[str, ...] = ()) -> AuthoringAuthState:
        access = value.get("accessToken")
        refresh = value.get("refreshToken")
        if not isinstance(access, str) or not isinstance(refresh, str) or not access or not refresh:
            raise AuthoringApiError(502, "invalid_auth_response")
        raw_roles = value.get("roles")
        response_roles = tuple(role for role in raw_roles if isinstance(role, str)) if isinstance(raw_roles, list) else roles
        return AuthoringAuthState(access, refresh, workspace_id, response_roles)

    def _request(self, method: str, path: str, payload: dict[str, object] | None, *, authenticated: bool = True) -> dict[str, object]:
        headers = {"Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if authenticated and self._state is not None:
            headers["Authorization"] = f"Bearer {self._state.access_token}"
            if self._state.workspace_id is not None:
                headers["X-Workspace-Id"] = self._state.workspace_id
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        status, _, raw = self._transport.request(method, self.config.base_url.rstrip("/") + path, headers, body, self.config.timeout_seconds)
        try:
            value = json.loads(raw.decode()) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AuthoringApiError(502, "invalid_json_response") from error
        if status < 200 or status >= 300:
            error = value.get("error") if isinstance(value, dict) else None
            raise AuthoringApiError(status, error if isinstance(error, str) else "request_rejected")
        if not isinstance(value, dict):
            raise AuthoringApiError(502, "invalid_response")
        return value
