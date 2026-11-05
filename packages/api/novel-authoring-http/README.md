---
description: "HTTP authentication and workspace-scoped novel authoring requests over an injected platform controller."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-novel-authoring-http

English | [中文](README.zh.md)

## Summary

Hosts can expose authentication, workspace membership, novel drafts, generation, review, publication, rollback, and saved context through one `/api` adapter. The host resolves authenticated principals and injects database-backed services. Browser users can queue generation and review drafts; separately authenticated workers perform generation and materialization. Request bodies are bounded before dispatch, and client-supplied identities never establish workspace authority.

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

The composing host must supply `ctx.webServer` and `ctx.platformHttpController` before mounting this Cordis plugin. The controller joins authentication routes with authoring services selected from a server-resolved `AuthPrincipal`; it never accepts a client user ID, role, or membership as authority.

### Minimal configuration

Mount this row in a composition that already supplies both injected services:

```yaml
- name: '@deepseek-ai/dsh-api-novel-authoring-http'
  config:
    maxBodyBytes: 65536
```

| Field | Default | Meaning |
|---|---|---|
| `maxBodyBytes` | 65536 when the config argument is omitted | Positive safe-integer ceiling for collected request bytes; an explicitly supplied config must include it |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-novel-authoring-http) lists the accepted config. Oversized bodies return `413 payload_too_large`; malformed JSON and body-read errors return `400 invalid_request` before the controller runs. The adapter forwards method, pathname, headers, parsed body, and socket peer address, then writes the controller's status, headers, and serialized body.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply()` registers the `/api` prefix and its disposer through the WebServer route registry. It does not claim the SPA fallback. `PlatformHttpController` delegates authentication and builds authoring services after resolving the principal; `NovelAuthoringHttpController` dispatches domain operations with that identity.

Workspace and novel creation, member invitations/listing/role changes/revocation, ownership transfer, and archive/restore operations belong to authenticated domain services. Generation-run creation, worker-only generation and proposal materialization, review/publication, rollback, and persisted-context reads return business statuses for a Web UI. Browser principals can enqueue runs and review proposals but cannot invoke worker-only generation and proposal routes. Cookie/JWT parsing remains with the injected authentication services.

The [implementation](src/index.ts) owns dispatch and response mapping; [Web adapter tests](tests/web-adapter.spec.ts) exercise bounded request handling, and [controller tests](tests/controller.spec.ts) exercise principal-based dispatch.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [HTTP subsystem](../../../docs/subsystems/web-server.md): injected controller and carrier ownership.
- [Authentication library](../../identity/user-auth/README.md): credentials and principal resolution.
- [Authoring library](../../storage/novel-authoring/README.md): generation and publication services.

-----

<a id="model-experience"></a>
## Model Experience

None, as HTTP dispatch delegates generation to injected services that construct model requests.

#### KV Cache effect

The adapter does not construct or mutate model input prefixes; generation services and providers own caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This package is an HTTP adapter, not a complete server or Web UI. The host supplies authentication/session resolution, email/Redis controls, and browser presentation. The optional generation route requires the injected `NovelGenerationWorkflowService` and its provider/storage adapters.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
