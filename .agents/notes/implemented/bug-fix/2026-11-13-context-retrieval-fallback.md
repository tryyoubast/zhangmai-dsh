# Agent Note: Strict-first context retrieval and keyless continuation checks

Status: implemented

English | [中文](2026-11-13-context-retrieval-fallback.zh.md)

## Problem

`plainto_tsquery` joins normalized words with AND. A complete writing instruction includes output-format words that historical story records do not contain. Real acceptance produced three durable drafts but selected no history; a short-keyword mock did not expose the failure. Provider completion and credential availability do not prove that continuation used saved context.

## Decision

The [context repository](../../../../packages/storage/novel-authoring/src/context-repository.ts) keeps strict matching first. Only an empty visible result triggers any-term matching using PostgreSQL-normalized, safely quoted lexemes. Matching and relevance scoring share the effective query. Both paths retain the fourteen source branches, tenant/novel scope, RLS, status exclusions, bounded excerpts, and candidate limit. Existing GIN expressions remain unchanged; the optimizer chooses their use. No-term and unmatched inputs return no candidates.

The approach follows [pg_search's any_word mechanism](https://github.com/Casecommons/pg_search#any_word) using native PostgreSQL capabilities. It introduces no dependency, migration, model keyword-extraction call, or public request field. Existing saved results and ranked context snapshots retain their replay behavior.

The [worker preflight](../../../../deploy/local-test/context-preflight.mjs) resolves the fixed seed run's current identity, verifies novel ownership, and invokes production retrieval and ranking with the exact instruction and limit. Its connection defaults transactions to read-only and uses only the worker credential. It reports source identifiers, ranks, and hashes. Empty context stops resume before provider selection and budget reservation. The complete instruction also runs through the deployed fixed model in an independent novel, followed by persistence and restart checks.

The [resume orchestrator](../../../../deploy/local-test/real-resume.ts) reports a redacted failure stage and known fixture/run locators. Task completion describes execution; a failed snapshot assertion remains a failed acceptance stage. Independent reports preserve the original failure, and paid budget reservations are never reduced.

## Alternatives considered

**Replace plain queries with web-search queries.** Ordinary multiword web-search input still uses AND, so changing the parser alone does not solve full-instruction retrieval.

**Add independent search keywords to the public request.** Separating retrieval from writing may improve relevance, but requires a new HTTP, queue, and durable request contract. Strict-first fallback addresses the demonstrated failure within the current interface.

**Use recent rows or weaken the nonempty-context assertion.** Recent rows need not match the story request, while removing the assertion conceals the missing history. Empty results remain observable.

**Introduce vector search or an additional model call.** This requires extra infrastructure, indexing, or paid work. Native any-term matching supports the current bounded regression without these costs.

## Consequences

Any-term matching can admit weak matches from generic formatting words and can examine more indexed postings. Candidate bounds limit returned items, not all database work. Query plans must be inspected on representative data; small fixtures may legitimately use sequential scans. The `simple` dictionary supplies no Chinese segmentation, and this fix makes no general Chinese or semantic-search claim.

Keyless tests establish retrieval, isolation, budgeting, reporting, and restart behavior. They do not establish successful real continuation. The exhausted 2/2 campaign and original failure reports remain historical evidence; another real attempt requires a separate budget decision.
