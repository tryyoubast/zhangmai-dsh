from __future__ import annotations

import json

import pytest

from deepseek_harness import AuthoringClient, AuthoringClientConfig
from deepseek_harness.errors import AuthoringApiError


class FakeTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, str], dict[str, object] | None]] = []
        self.responses: list[tuple[int, dict[str, str], bytes]] = []

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> tuple[int, dict[str, str], bytes]:
        del timeout
        payload = json.loads(body.decode()) if body is not None else None
        self.calls.append((method, url, headers, payload))
        return self.responses.pop(0)


def response(value: dict[str, object], status: int = 200) -> tuple[int, dict[str, str], bytes]:
    return status, {}, json.dumps(value).encode()


def test_login_refresh_and_generate_use_official_tokens_and_selected_workspace() -> None:
    transport = FakeTransport()
    transport.responses.extend([
        response({"accessToken": "access-1", "refreshToken": "refresh-1"}),
        response({"accessToken": "access-2", "refreshToken": "refresh-2"}),
        response({"ok": True, "status": "draft", "records": []}),
    ])
    client = AuthoringClient(AuthoringClientConfig("https://writer.example/api"), transport=transport)

    client.login("writer@example.com", "password-password", workspace_id="workspace-1")
    client.refresh()
    result = client.generate_draft("novel-1", "写一个开场", idempotency_key="request-1")

    assert result["status"] == "draft"
    assert transport.calls[0][0:2] == ("POST", "https://writer.example/api/auth/login")
    assert transport.calls[1][3] == {"refreshToken": "refresh-1"}
    assert transport.calls[2][2]["Authorization"] == "Bearer access-2"
    assert transport.calls[2][2]["X-Workspace-Id"] == "workspace-1"


def test_api_errors_do_not_return_or_store_raw_credentials() -> None:
    transport = FakeTransport()
    transport.responses.append(response({"error": "invalid_credentials"}, status=401))
    client = AuthoringClient(AuthoringClientConfig("https://writer.example"), transport=transport)

    try:
        client.login("writer@example.com", "password-password")
    except AuthoringApiError as error:
        assert error.status == 401
        assert "password-password" not in str(error)
    else:
        raise AssertionError("login should fail")


def test_auth_state_repr_does_not_include_opaque_credentials() -> None:
    transport = FakeTransport()
    transport.responses.append(response({"accessToken": "access-secret", "refreshToken": "refresh-secret"}))
    client = AuthoringClient(AuthoringClientConfig("https://writer.example"), transport=transport)

    state = client.login("writer@example.com", "password-password")

    assert "access-secret" not in repr(state)
    assert "refresh-secret" not in repr(state)


def test_list_workspaces_and_switch_workspace_validate_server_membership() -> None:
    transport = FakeTransport()
    transport.responses.extend([
        response({"accessToken": "access-1", "refreshToken": "refresh-1"}),
        response({"workspaces": [
            {"id": "workspace-1", "name": "One", "status": "active", "role": "owner"},
            {"workspaceId": "workspace-2", "name": "Two", "status": "active", "role": "editor"},
        ]}),
    ])
    client = AuthoringClient(AuthoringClientConfig("https://writer.example/api"), transport=transport)

    client.login("writer@example.com", "password-password")
    workspaces = client.list_workspaces()
    assert [workspace.workspace_id for workspace in workspaces] == ["workspace-1", "workspace-2"]
    assert client.switch_workspace("workspace-2").workspace_id == "workspace-2"

    with pytest.raises(AuthoringApiError) as error:
        client.switch_workspace("workspace-foreign")
    assert error.value.status == 403
    assert error.value.error == "workspace_forbidden"


def test_logout_revokes_remote_session_and_clears_credentials() -> None:
    transport = FakeTransport()
    transport.responses.extend([
        response({"accessToken": "access-1", "refreshToken": "refresh-1"}),
        response({}, status=204),
    ])
    client = AuthoringClient(AuthoringClientConfig("https://writer.example/api"), transport=transport)

    client.login("writer@example.com", "password-password")
    assert client.auth_state is not None
    client.logout()

    assert client.auth_state is None
    assert transport.calls[1][0:2] == ("POST", "https://writer.example/api/auth/logout")
    assert transport.calls[1][2]["Authorization"] == "Bearer access-1"


def test_config_rejects_unsafe_or_malformed_base_urls() -> None:
    with pytest.raises(ValueError):
        AuthoringClientConfig("writer.example/api")
    with pytest.raises(ValueError):
        AuthoringClientConfig("https://writer.example/api?token=secret")
    with pytest.raises(ValueError):
        AuthoringClientConfig("https://writer.example/api", timeout_seconds=0)


def test_workspace_listing_requires_an_authenticated_client() -> None:
    client = AuthoringClient(AuthoringClientConfig("https://writer.example/api"), transport=FakeTransport())

    with pytest.raises(AuthoringApiError) as error:
        client.list_workspaces()

    assert error.value.status == 401
