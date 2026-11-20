# Agent Note: Credential preflight and bounded real-provider resume

Status: implemented

English | [中文](2026-11-13-bounded-real-provider-resume.zh.md)

## Problem

A credential rejection must be distinguishable from an authoring failure before acceptance creates business fixtures or spends its remaining generation allowance. A restarted acceptance process cannot infer whether a previous provider request was billed. Recreating a two-task budget, refunding a failed submission, or allowing concurrent worker endpoint changes can exceed the operator's approved allowance and overwrite earlier evidence.

## Decision

The [local acceptance reference](../../../../deploy/local-test/README.md#real-provider-acceptance) owns the commands and recovery procedure. The [provider checker](../../../../deploy/local-test/provider-check.mjs) requests the official model catalogue through an isolated Compose tool using the worker's network and provider secret. It requires HTTP 200 and the configured model within 15 seconds. The tool has no database credentials or application-home mount; a read-only script bind supplies current code. Fixed diagnostics retain status and model presence without response bodies, key material, or exception causes. The management command separately reports the host key file's resolved path and modification time.

The [budget owner](../../../../deploy/local-test/real-budget.ts) holds an exclusively created lock across preflight, fixed-model fixtures, paid work, restarts, and fixed-worker restoration. Ordinary acceptance refuses any existing budget; explicit resume requires exactly one of the two tasks already submitted. An existing lock is never removed automatically. Reservation atomically persists the next count before HTTP submission and never refunds it, including after interruption or provider failure.

Mock acceptance and service start, restart, stop, and reset use that same lock. They cannot recreate the shared worker during a paid attempt or send mock submissions to its temporary real endpoint.

Resume checks HTTPS readiness, successful mock evidence, and the provider credential before business writes. It prepares all fourteen draft target types with the fixed model in a new account and novel, restarts, and validates stored data. The [context preflight decision](2026-11-13-context-retrieval-fallback.md) requires read-only worker retrieval with the full continuation instruction before changing provider or reserving the final task. One real generation produces character, location, and chapter drafts at chapter 2, with one provider call and no enrichment or automatic retries. A second restart verifies stored draft results and context identifiers, ranks, and hashes. Worker restoration follows every owned stage outcome and is verified before unlocking. Credential rejection leaves the submitted count unchanged.

Resume reports use unique names and preserve the original real-acceptance report. Evidence contains safe locators, scenario outcomes, and fixed-fixture identifiers. [The staging architecture decision](../architecture/2026-11-11-local-novel-staging.md) remains active for profile composition, restricted database ownership, durable queues, and keyless CI; this note owns the paid-task recovery policy.

## Alternatives considered

**Validate the credential with a generation request.** This spends the remaining allowance before the fixture and persisted-context checks can run. The model catalogue proves credential and model availability without submitting a generation task.

**Reset the budget or refund failed calls.** A failed or interrupted client cannot establish that the provider did not accept or bill its request. Reserving before submission retains the approved maximum even when a task produces no useful result.

**Lock only while updating the budget.** Another acceptance process could change the worker endpoint during preparation or verification. The lock covers the complete acceptance interval and restoration.

**Resume in the earlier report and business fixtures.** This conflates independent attempts and makes the original failure harder to inspect. A fresh fixed-model dataset and unique report preserve attribution without another paid setup request.

## Consequences

One paid attempt can be lost after reservation without a completed result. A stale lock requires operator investigation; automatic recovery cannot prove that its owner has stopped or that a provider request was not accepted. A successful catalogue check does not prove that generation quota, output validity, publication, or restart recovery will succeed. Mocked tests establish rejection, command routing, locking, and budget behavior; only the local operator's actual reports establish real-provider completion. This change introduces no product authentication, authorization, business logic, or database migration.

Reservations sync the temporary file before atomic rename and sync its parent directory on POSIX. Node does not expose directory sync on Windows; the interruption test covers process exit, not sudden power loss or storage-controller failure. Existing counts are never reduced by recovery.
