# Agent Note: Chapter storage fields during materialization

Status: implemented

English | [中文](2026-11-11-chapter-storage-materialization.zh.md)

## Problem

Generated chapter versions pass through materialization before the real draft writer validates storage. Missing fields normalize to null, but the writer requires the unused inline-text or object-key field to be absent. Both valid storage modes therefore fail before persistence.

## Decision

Chapter-version materialization converts only missing `contentText` and `contentObjectKey` values to undefined, so the existing optional-field filter omits them. Nullable summaries and canonical proposal JSON keep their null semantics. The [long-form storage rules](../architecture/2026-09-23-postgres-novel-drafts-and-review.md) remain authoritative; this repair changes no storage thresholds or validation rules.

## Alternatives considered

**Remove nulls globally from optional fields.** Other nullable draft fields and canonical proposal JSON use null deliberately. Restricting normalization to the two mutually exclusive storage inputs preserves those meanings.

## Consequences

Valid inline and object-backed chapters reach persistence without weakening the writer's rejection of conflicting storage fields. A regression uses the real `LongformAuthoringService` validator with a captured database driver, verifies both storage modes and proposal nulls, and rejects conflicting fields before any database or proposal write.
