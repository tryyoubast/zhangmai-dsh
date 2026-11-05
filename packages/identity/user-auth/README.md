---
description: "Server-side password and token lifecycle primitives for multi-user novel authoring."
kind: "package-library"
---

# @deepseek-ai/dsh-user-auth

English | [中文](README.zh.md)

## Summary

This host-only package provides Argon2id password hashing, normalized email validation, verification/reset lifecycle seams, opaque session and refresh-token contracts, EdDSA access-token primitives, and a framework-neutral `AuthHttpController`. The controller covers the authentication route contract for Web and official-client adapters; it is not an HTTP server or framework router. Stores and infrastructure are injected by the caller; raw passwords and tokens are never part of persisted records.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The host imports services and stores and connects the controller to its HTTP adapter; this library has no plugin mount.

### HTTP adapter

`AuthHttpController.handle()` dispatches these routes:

- `POST /api/auth/register`
- `POST /api/auth/verify-email`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/refresh`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/me`

Browser login returns a `__Host-dsh_session` cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. Official-client login and refresh return a short-lived EdDSA access token plus a rotated opaque refresh token. State-changing requests can enforce an allowed `Origin`; the host application must still connect the controller to its HTTP framework, session resolver, workspace identity resolver, and key management.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Security contract

Use `UserAuthService` with a transactional `AuthStore`. Persist only `hashToken()` results for opaque tokens. Use `RefreshTokenService` to rotate refresh tokens and revoke a token family after reuse. The PostgreSQL adapter serializes rotation and `revokeFamily()` with the same transaction advisory lock per family. Password reset locks each affected family in UUID order before it updates the password, sessions, or refresh tokens. Rotation re-reads and locks the presented token row after acquiring that lock in an explicit `READ COMMITTED` transaction; a replay revokes every committed descendant and appends a security audit event atomically. Unknown, expired, revoked, and reused tokens are all returned to HTTP callers as `401 invalid_refresh_token`; database failures still propagate. Keep EdDSA private keys in a secret manager and keep access-token claims free of email, password, and other PII.

Email verification is one required store operation: the backing store consumes an unexpired, unused token and activates its user atomically.

`AuthHttpController.handle()` awaits route operations inside its error handler. Credential-validation errors matching its existing classification return `400 invalid_request`; other failures return `500 authentication_unavailable` without raw error details. Session resolvers may use instance state: the controller calls their methods on the resolver object. JWT parsing validates decoded objects and fields before exposing claims.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [HTTP subsystem](../../../docs/subsystems/web-server.md): request and response adaptation.
- [PostgreSQL library](../../database/database-postgres/README.md): pool and credential ownership.

-----

<a id="model-experience"></a>
## Model Experience

None, as authentication resolves server-side principals without constructing model requests.

#### KV Cache effect

Authentication does not mutate model input prefixes; services consuming the principal own subsequent requests and caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The package does not provide a complete HTTP server/router, Redis client, SMTP client, cookie middleware, or a key-management service. `PostgresAuthStore` and `PostgresRefreshTokenStore` are thin Drizzle-backed Store adapters, but the caller owns the PostgreSQL connection pool, migrations, transaction/RLS context, and runtime credentials. Deployments must provide Redis rate limiting, SMTP/mail delivery, workspace identity resolution, EdDSA key storage, and the surrounding framework adapters. Use a Node runtime with the required Argon2 primitive.
- The Store owns top-level database transactions; callers must not wrap it in an existing transaction. All rotation and family-revocation implementations must use the same family-lock protocol; `create()` issues only the first token in a fresh family, and descendants go through `rotate()`. Deployments must drain old refresh requests and instances before routing refresh traffic to this implementation; mixed versions do not guarantee family revocation. Other sessions and access-token lifetimes are unchanged.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
