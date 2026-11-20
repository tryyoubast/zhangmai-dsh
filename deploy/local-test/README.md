---
description: "Run isolated local PostgreSQL, Redis, mail, HTTPS API, and generation-worker acceptance through Docker Compose."
---

# Local novel-authoring acceptance

English | [中文](README.zh.md)

## Summary

Start an empty, isolated test application and exercise registration, verified login, draft generation, review, publication, rollback, and restart recovery through HTTPS. The fixed model runs without a provider key; a separate command permits at most two real DeepSeek generation tasks. This environment retains test data and audit history across shutdowns.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Start and verify](#start-and-verify)
- [Real provider acceptance](#real-provider-acceptance)
- [Stop and preserve data](#stop-and-preserve-data)
- [Isolation and ownership](#isolation-and-ownership)
- [Evidence and troubleshooting](#evidence-and-troubleshooting)
- [Dev Note](#dev-note)

<a id="prerequisites"></a>
## Prerequisites

Use Node 24, pnpm 11.7.0, and Docker Desktop with a running Linux engine and Compose. Run commands from the repository root after `pnpm install --frozen-lockfile`. Windows management commands locate Docker Desktop's standard CLI installation automatically. Ports 8443 and 8025 must be available on loopback.

[images.lock.env](images.lock.env) pins reviewed image digests. Docker Library images use their official AWS Public ECR distribution; Mailpit uses the publisher's GHCR distribution. The application image is built from the current checkout with the pinned Node image and frozen workspace dependencies.

<a id="start-and-verify"></a>
## Start and verify

```sh
pnpm run staging:init
pnpm run staging:up
pnpm run staging:test
```

Initialization creates ignored credentials, an Ed25519 key pair, and independent `novel-api`/`novel-worker` profiles in `.local/`. Repeating initialization preserves existing materials and rejects a mismatched key pair. Startup builds the application, stops API and worker before provisioning only `dsh_staging_test` and `dsh_refresh_test`, starts the API before the worker through `dsh --profile` to serialize cold shared-module preparation, and copies Caddy's local CA to `.local/local-ca.crt`. Interrupted initial ownership setup and runtime-role grants are completed on the next startup. Preserve a database backup before upgrading; a failed migration leaves both consumers stopped and retains all volumes.

The business endpoint is `https://localhost:8443`; Mailpit is `http://127.0.0.1:8025`. The acceptance client explicitly trusts the exported CA and maintains a real Cookie jar. It does not disable certificate checks or modify system trust. Test mail contains one-use verification/reset tokens; keep the mailbox local.

The mock flow explicitly selects the internal model regardless of inherited provider settings. It verifies fourteen draft target types, workspace isolation, archived workspace recovery, human review, publication and rollback, idempotency, rejected model output, partial materialization, pending-message recovery, interrupted-task failure, and Redis notification recovery. It also runs the independent restricted PostgreSQL suites and interrupted-bootstrap recovery in a separate disposable container. The upgrade tool creates a uniquely named disposable database at 0019, checks forward migration and provenance collisions with restricted credentials, and retains its rows and audits; only its initial bootstrap uses the administrator. Individual PASS lines and `.local/evidence/mock-acceptance.json` report actual progress; a failed command is not a completed acceptance run.

Run only the restricted PostgreSQL suites with:

```sh
pnpm run staging:test:postgres
```

<a id="real-provider-acceptance"></a>
## Real provider acceptance

Write the API key directly to `.local/secrets/deepseek-api-key`; never paste it into a command, chat, or committed file. Complete mock acceptance first, then check the credential:

```sh
pnpm run staging:check:provider
```

The isolated tool uses the worker's Compose network and provider secret, with no database credentials or application-home mount. Its read-only script bind requires no image rebuild. It requests only `https://api.deepseek.com/v1/models` and requires HTTP 200 plus the configured `DSH_NOVEL_PROVIDER_MODEL` catalogue entry, defaulting to `deepseek-chat`. Missing or empty keys, HTTP 401, transport failure, a 15-second deadline, invalid JSON/catalogues, and absent models fail with a nonzero exit. Diagnostics contain fixed result labels, HTTP status, model presence, and the host's resolved key-file path and modification time; they exclude keys, response bodies, and exception details. This command submits no generation task and does not change the paid-task budget.

Start a fresh campaign only when `.local/evidence/real-provider-budget.json` does not exist:

```sh
pnpm run staging:test:real
```

The campaign permits at most two real generation tasks. An existing budget rejects an ordinary invocation and preserves the original `real-acceptance.json`. To use the single remaining task, the existing budget must contain exactly `submitted: 1` and `maximum: 2`:

```sh
pnpm run staging:test:real -- --resume
```

Resume holds an exclusive `.local/evidence/real-provider-budget.lock` across HTTPS, mock-evidence and credential checks, fixed-model preparation, the paid request, restarts, and worker restoration. Mock acceptance and `up`, `restart`, `down`, and `reset` acquire the same lock, preventing concurrent endpoint changes. An existing or stale lock rejects the run and is never removed automatically; inspect its recorded owner before manual recovery. Failed credential preflight, including HTTP 401, creates no business data and leaves the budget unchanged.

After preflight, resume creates a new user and novel, uses the fixed model to prepare all fourteen target types, and checks them after a restart. Before switching provider or reserving budget, the worker runs production retrieval and ranking with the exact continuation instruction and `limit: 8`. This read-only check verifies the seed run's identity and novel ownership, returns source identifiers, ranks, and hashes, and rejects empty context. It then atomically records `submitted: 2` before submitting exactly one real request for character, location, and chapter drafts (`chapterNo: 2`), with one provider call and no enrichment or automatic retry. Submission failure, quota failure, network failure, or process interruption never refunds that reservation. A second restart checks the saved draft results and selected context identifiers, ranks, and hashes without another real request.

Mock acceptance exercises that full instruction in an independent fixed-model novel and verifies chapter 2, historical source ownership, and exact context after restarting. It never changes the paid budget. A completed task alone does not establish persistence acceptance: failed resume reports include `failureStage`, known run locators, and a failed scenario. The [retrieval decision](../../.agents/notes/implemented/bug-fix/2026-11-13-context-retrieval-fallback.md) explains strict matching and its any-term fallback.

Resume writes a separate `real-acceptance-resume-<UUID>.json` and preserves the original report. Every owned stage outcome triggers fixed-model worker restoration and verification before releasing the lock. The internal endpoint always uses a fixed non-secret credential, even when a real secret exists. Keep the budget and reports together; changing or replenishing the paid budget requires a new explicit acceptance decision. [The decision record](../../.agents/notes/implemented/bug-fix/2026-11-13-bounded-real-provider-resume.md) defines the conservative failure policy. Keyless tests and successful credential preflight do not establish two successful real generations; the local operator must inspect the actual acceptance reports.

<a id="supplemental-real-acceptance"></a>
### Supplemental real acceptance

The approved supplement uses the original `E:/Codex/staging-acceptance/local-state`, its exhausted historical ledger, and the `deepseek-flash` model. Rebuild and pass the complete fixed-model acceptance on the running API and worker images before checking the model catalogue and starting the supplement:

```powershell
$env:DSH_NOVEL_PROVIDER_MODEL = 'deepseek-flash'
pnpm run staging:check:provider -- --state-dir E:/Codex/staging-acceptance/local-state
pnpm run staging:test:real -- --supplement --state-dir E:/Codex/staging-acceptance/local-state
```

The separate `real-provider-budget-supplement.json` reserves at most two tasks without changing the original ledger. This limit counts submissions; it is not a currency cap. The first task creates three drafts in a new novel. Before reserving the second task, the runner compares the restored first chapter and its drafts, then checks that the full continuation instruction retrieves context exclusively from that first task. The second task must persist the new drafts and exactly the preflight context, including source IDs, rank and hash. The runner compares the stored snapshot after another restart and restores the fixed-model worker. Keep the staging API idle from other clients while the real endpoint is selected.

If the first task has a verified checkpoint and the second has not been reserved, use the following command after inspecting the failed stage. The runner logs in as the same test user using a local secret protected by Windows DPAPI and rechecks the original drafts and context before continuing. If the earlier process left a lock, verify that the process is no longer running and the worker is no longer processing its task before handling the lock manually. A missing or invalid checkpoint, ambiguous first submission or already reserved continuation blocks another submission. The supplement does not refund or repeat any submission.

```powershell
pnpm run staging:test:real -- --supplement --resume --state-dir E:/Codex/staging-acceptance/local-state
```

Reports are written independently of the historical attempts. Use the ledger for reservation totals and the report for acceptance and restoration outcomes. [The decision record](../../.agents/notes/implemented/bug-fix/2026-11-18-real-provider-supplement.md) explains the checkpoint and budget rules.

<a id="stop-and-preserve-data"></a>
## Stop and preserve data

```sh
pnpm run staging:down
```

Shutdown removes this project's containers and network while retaining named volumes, credentials, profiles, and evidence. Starting again checks migration history and reuses the stored application data. Destruction is a separate explicit operation, `pnpm run staging:reset -- --confirm=dsh-local-test`, which removes only the project's volumes; it is not part of acceptance or ordinary shutdown.

<a id="isolation-and-ownership"></a>
## Isolation and ownership

Only HTTPS and the mailbox UI publish loopback ports. PostgreSQL, Redis, SMTP, the fixed model, and the worker stay on the Compose network. The project name is `dsh-local-test`; its volumes contain no imported local business data.

The one-shot provisioner uses the temporary administrator for migration 0001 and ownership bootstrap, then uses the restricted migrator for later migrations. API pools separately assume auth, app, and service roles; the worker pool assumes only the worker role. Runtime profiles receive neither administrator nor migrator secrets. The inspection tool has its own migrator secret and opens read-only transactions; worker denial probes use only the worker's credential and roll back every attempted write.

The business database and refresh-token regression database have separate runtime and migrator logins. Regressions require test-named databases and do not load production `.env` files. Their tool containers keep the application image read-only and mount only temporary Vite caches in memory. Audit rows remain append-only. [Database ownership](../../packages/database/database-postgres/README.md) and [worker identity](../../packages/storage/novel-authoring/README.md) own the SQL and RLS details.

The [host](../../packages/host/novel-host/README.md) owns connection closure, request authority, broker intake, and SMTP transport. The queue carries only workspace/run locators; PostgreSQL supplies current user/session/membership authority. Notification failure returns 503 after persistence, so clients retry the same request and idempotency key. Interrupted running work becomes failed and requires a new key for an intentional new generation.

<a id="evidence-and-troubleshooting"></a>
## Evidence and troubleshooting

`.local/evidence/` contains image identities and scenario results, never injected keys, mail bodies, authorization headers, or full provider responses. The required CI job uploads this directory and always shuts down the Compose project. Real provider acceptance is local and is not counted as keyless CI evidence.

`GET /health/live` checks process liveness. `GET /health/ready` checks restricted database roles and minimum schema capabilities, Redis, and SMTP without calling a model. It does not read the private migration journal; the provisioner owns migration checksums. Use Compose service status and redacted logs to distinguish image/network/startup problems from a failed business assertion. Do not replace a failed Compose run with a unit-test or native-database result.

<a id="dev-note"></a>
## Dev Note

The local CA and credentials are disposable environment materials. This environment is an acceptance target, not a production deployment guide; production DNS, secrets management, backups, scaling, monitoring, and recovery objectives require a separate deployment decision.
