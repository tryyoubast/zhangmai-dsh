---
description: "Run authenticated novel-authoring HTTP requests and a recoverable generation worker with restricted PostgreSQL roles, Redis, and SMTP."
kind: "package-reference"
---

# @deepseek-ai/dsh-novel-host

English | [中文](README.zh.md)

## Summary

Run a novel-authoring API or one generation worker with PostgreSQL, Redis Streams, and SMTP. Users authenticate, queue persisted generation requests, and read saved results through the API. The worker derives current authority from each persisted run and creates drafts through the configured provider. Deployment supplies restricted credentials, schema, and HTTPS termination.

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

Launch this plugin through a custom `dsh` profile containing the [novel application bundle](../../bundle/novel-app/README.md). That bundle provides the complete mount configuration; direct mounts must supply every [Config](src/config.ts) field. The [local staging guide](../../../deploy/local-test/README.md) owns infrastructure provisioning and execution.

### Deployment settings

The host validates settings before opening resources. Defaults belong to the bundle patch, rather than the host implementation.

| Field group | Required settings | Responsibility |
|---|---|---|
| `mode`, `secretDirectory`, `origin` | `api` or `worker`, mounted secret directory, HTTPS origin | Select the process and browser write policy |
| `database` | Endpoint, database, four login names, pool size and timeouts | Open auth/app/service pools in API mode or only the worker pool |
| `redis`, `smtp` | Endpoints, stream/group, sender and timeouts | Notify queued runs, enforce auth limits, and deliver auth mail |
| `server`, `provider`, `auth` | HTTP bind/body limit, model endpoint/bounds, token/account settings | Configure transport, generation, and authentication |

The host reads fixed secret filenames: its own database-role passwords, `redis-password`, and the API's matching Ed25519 `access-private.pem`/`access-public.pem` pair. A real provider requires `deepseek-api-key`; the exact internal fixture URL `http://model:8081/v1` always uses `fixture-only` and never reads the real key. Secret text and driver errors do not appear in host failure responses.

### Availability and shutdown

Both modes expose GET `/health/live` and `/health/ready`. Readiness checks restricted database roles and required catalog capabilities through migration 0022, including the worker settlement function, invoker publication and candidate triggers, eight partial history indexes, six long-form service read policies, and the required predicate privileges, plus Redis and SMTP without calling the model. Missing capabilities or dependencies prevent startup or return `503 {"ready":false}`. Health requests during shutdown return 503 without starting dependency probes. The host contains idle PostgreSQL pool errors with a fixed diagnostic and removes pool listeners after close. Initialization failure closes acquired resources. Unload stops queue intake, waits for active requests and deliveries, and then closes external clients and pools.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The API assembles existing authentication and authoring services under separate restricted pools. Only successful login can onboard workspace membership; ordinary requests resolve existing database authority, with the workspace header serving only as a selection hint. Generation persistence commits before Redis notification; the [HTTP adapter](../../api/novel-authoring-http/README.md) owns notification failure and retry responses.

The worker holds a PostgreSQL session advisory lock before recovering pending Redis deliveries. Queue messages contain exactly `workspaceId` and `generationRunId` UUID fields. Each delivery resolves current user/session/membership authority from PostgreSQL. The worker acknowledges absent and terminal runs without calling the provider. An owned run that has lost authority is marked failed and audited before acknowledgement; if its authority is usable again, the worker retains the delivery. Interrupted `running` work becomes a stable failed run; queued work uses the domain service's atomic claim. Database failures retain pending deliveries, and provider failures are acknowledged only after persisted terminal state is observed. Ownership-connection loss stops intake and aborts the provider request.

| Source | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Resource acquisition, HTTP mounting, worker ownership, and teardown |
| [runtime.ts](src/runtime.ts) | Restricted domain-service composition and catalog readiness |
| [broker.ts](src/broker.ts), [queue.ts](src/queue.ts) | Redis protocol parsing, serial recovery, and delivery settlement |
| [boundaries.ts](src/boundaries.ts), [config.ts](src/config.ts) | Identity selection, fixture isolation, and deployment validation |

No invariant companion is published: persisted authoring state and membership remain the domain services' authorities, while infrastructure readiness probes external dependencies without maintaining an independent domain projection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Application bundle](../../bundle/novel-app/README.md): profile layer and environment settings.
- [Authentication](../../identity/user-auth/README.md): account, session, and token behavior.
- [Authoring services](../../storage/novel-authoring/README.md): persisted runs, claims, and draft generation.
- [Persisted worker identity](../../../.agents/notes/implemented/architecture/2026-11-11-generation-worker-identity.md): restricted identity lookup.

-----

<a id="model-experience"></a>
## Model Experience

### Worker generation

#### What the model sees

The worker delegates to `DeepSeekNovelGenerationAdapter`; the [authoring package](../../storage/novel-authoring/README.md#model-experience) owns its fixed instruction and persisted-context input. Redis fields, deployment secrets, and health responses add no model messages.

#### Token effect

Each newly claimed run can cause one provider request. Duplicate terminal deliveries and interrupted runs cause no provider call; the adapter owns input size and usage accounting.

#### KV Cache effect

The host does not modify message prefixes or manage a provider cache; the adapter and provider determine reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One worker may own a database's generation queue at a time; horizontal worker scheduling and automatic provider retries are absent.
- PostgreSQL commit and Redis notification are separate operations. An API notification failure requires resubmitting the same idempotent request; there is no transactional outbox.
- Catalog readiness verifies minimum required capabilities, not migration-journal hashes. Deployment owns complete schema provisioning, HTTPS, credential rotation, and durable infrastructure backups.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
