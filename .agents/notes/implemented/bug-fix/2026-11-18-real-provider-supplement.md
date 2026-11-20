# Agent Note: Bound supplemental real-provider acceptance

Status: implemented

English | [中文](2026-11-18-real-provider-supplement.zh.md)

## Problem

An exhausted acceptance allowance cannot verify a new real seed and its continuation. Resetting the ledger loses the distinction between past failures and newly authorized tasks, and a restarted process cannot tell whether an ambiguous submission was billed. A continuation from fixed fixtures does not establish that fresh real output can be retrieved after restart.

## Decision

The [staging runner](../../../../deploy/local-test/README.md#supplemental-real-acceptance) binds one two-task supplement to the exhausted historical ledger and retains the [existing fixed-fixture resume](2026-11-13-bounded-real-provider-resume.md) as a separate operation. Both ledgers share the worker management lock. The supplement requires full fixed-model evidence for the active application images and a credential check for the approved model. It writes each reservation and its request key atomically before submitting to HTTPS.

The first real task creates independent draft data. The ledger records the seed run and a digest of its verified snapshot, together with the model and continuation instruction digest. Cross-process recovery requires that checkpoint, exactly one reservation, and a fresh login as the same test owner. The disposable login secret is local, protected with Windows DPAPI, and absent from reports and container mounts. Missing or mismatched evidence prevents submission. No request with an ambiguous outcome is replayed.

The worker retrieves context under its restricted identity with the exact continuation instruction and limit before the second reservation. The check requires every source to belong to the first task. The runner compares the second task's stored context to that selection and compares the complete saved snapshot after restart. The fixed-model worker is restored and verified independently of the business outcome.

## Alternatives considered

**Reset or increase the historical counter.** It would mix independent attempts and permit an accidental replay on missing evidence. A single separate ledger preserves attribution and limits additional reservations.

**Spend one task on a fixed-model fixture.** That exercises the retrieval fix with a real continuation, but does not demonstrate that newly generated real history can be read after restart.

**Recover any request by resubmitting the same key.** The key does not prove that a provider accepted, billed, or completed an interrupted task. Recovery starts only from a verified seed and only before the continuation reservation.

## Consequences

An interruption before the seed checkpoint may leave one unusable reservation, and an interruption after the second reservation consumes the remaining allowance even without a result. A stale lock requires operator inspection. The runner constrains its generation task count, not currency cost. Provider output, context equality and actual restart persistence require deployment evidence; simulated calls verify the procedure without certifying a real provider run.
