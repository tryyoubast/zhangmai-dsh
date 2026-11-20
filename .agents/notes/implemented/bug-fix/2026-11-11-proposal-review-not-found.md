# Agent Note: Missing and invisible proposal review responses

Status: implemented

English | [中文](2026-11-11-proposal-review-not-found.zh.md)

## Problem

Proposal review resolves the requested proposal within the authenticated workspace. An absent or invisible proposal raises `proposal was not found` before any write, but the HTTP adapter classifies that domain rejection as an internal failure.

## Decision

The [authoring HTTP controller](../../../../packages/api/novel-authoring-http/src/index.ts) maps only an `Error` with the exact message `proposal was not found` to `404 {"error":"not_found"}`. Missing and cross-workspace identifiers receive identical responses. The review service retains its workspace-scoped lookup and write ordering. Permission errors map to 403, and unexpected failures map to a redacted 500 response.

## Alternatives considered

**Match every message containing “not found.”** Infrastructure and unrelated domain failures can contain those words. An exact match handles the existing review rejection without changing their classification.

## Consequences

Clients can treat an unavailable proposal as a failed lookup without learning whether it exists in another workspace. The adapter depends on one existing domain-error message; a future change to that message requires updating its mapping and regression together.

## Testing

[Controller tests](../../../../packages/api/novel-authoring-http/tests/controller.spec.ts) compose the real review service with an empty database result, verify identical 404 responses and zero writes, and confirm the authenticated workspace is passed despite a foreign workspace in the body. Similar error messages, unexpected exceptions, and thrown strings remain 500; permission failures remain 403.
