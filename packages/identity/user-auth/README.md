---
description: "Server-side password and token lifecycle primitives for multi-user novel authoring."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-auth

English | [中文](README.zh.md)

## Summary

This host-only package provides Argon2id password hashing, normalized email validation, verification/reset lifecycle seams, opaque session and refresh-token contracts, EdDSA access-token primitives, and a framework-neutral `AuthHttpController`. The controller covers the authentication route contract for Web and official-client adapters; it is not an HTTP server or framework router. Stores and infrastructure are injected by the caller; raw passwords and tokens are never part of persisted records.

## HTTP adapter

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

## Security contract

Use `UserAuthService` with a transactional `AuthStore`. Persist only `hashToken()` results for opaque tokens. Use `RefreshTokenService` to rotate refresh tokens and revoke a token family after reuse. Keep EdDSA private keys in a secret manager and keep access-token claims free of email, password, and other PII.

## Model Experience

Nothing in this package is model-visible. Authentication decisions remain in the HTTP/client boundary and are passed to domain services as a server-resolved principal.

## Known Limitations and Deferred Work

- The package does not provide a complete HTTP server/router, Redis client, SMTP client, cookie middleware, or a key-management service. `PostgresAuthStore` and `PostgresRefreshTokenStore` are thin Drizzle-backed Store adapters, but the caller owns the PostgreSQL connection pool, migrations, transaction/RLS context, and runtime credentials. Deployments must provide Redis rate limiting, SMTP/mail delivery, workspace identity resolution, EdDSA key storage, and the surrounding framework adapters. Use a Node runtime with the required Argon2 primitive.
