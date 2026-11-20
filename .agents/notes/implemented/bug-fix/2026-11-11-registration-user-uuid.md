# Agent Note: Registration uses native UUID generation

Status: implemented

English | [中文](2026-11-11-registration-user-uuid.zh.md)

## Problem

Registration IDs must fit PostgreSQL's UUID column. A custom formatter that inserts version and variant digits into an already complete random string produces an invalid 38-character value, so registration fails before the verification email can be sent. In-memory stores do not enforce this database type.

## Decision

The [authentication service](../../../../packages/identity/user-auth/src/index.ts) uses Node's `randomUUID()` for new user IDs. PostgreSQL validates the ID while the authentication runtime persists the pending account. Email verification, password hashing, session creation, and refresh-family behavior retain their existing semantics.

## Alternatives considered

**Repair the custom formatter.** Maintaining another UUID implementation adds formatting and version-bit obligations already supplied by Node. The service already uses the native function for other authentication identifiers.

**Change the database ID to text.** Removing the type constraint hides malformed identifiers and requires unrelated foreign-key migrations. Registration must satisfy the existing schema.

## Consequences

The service unit test requires a valid version-4 UUID. A restricted PostgreSQL registration test verifies the pending account, password hash, one-use email verification, and browser session; HTTPS acceptance additionally exercises the deployed registration and mail flow. These checks complement one another because a store double cannot reject invalid PostgreSQL input.
