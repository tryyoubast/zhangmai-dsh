# Agent Note: Indexed novel context retrieval

Status: implemented

English | [中文](2026-10-29-indexed-novel-context-retrieval.zh.md)

## Problem

Novel context retrieval ranked every row from all supported source types before it could discard rows that did not match the instruction. That made each request compute full-text rank across the whole novel.

## Decision

`PostgresNovelContextRepository.findCandidates` applies the same `simple` `to_tsvector` expression used by each source's GIN index before calculating `ts_rank`. It keeps the existing lifecycle filter, ordering, and 500-row cap, so only matching rows enter ranking and unmatched rows are never used to fill the cap. `hydrateContext` reads only the requested source type and IDs, preserving snapshot replay without a search query. Migration `0014_novel_context_fulltext_indexes.sql`, the Drizzle schema, and the migration journal define the fourteen source indexes.

## Alternatives considered

**Rank every source row and filter in application code** loses the database index and retains the original work for every request.

**Index only the most common source types** leaves retrieval cost and source coverage inconsistent, so all fourteen persisted source types use the same bounded expression approach.

## Consequences

Instructions with no full-text matches return an empty candidate set, and instructions with fewer matches than the limit return only those matches. Hydration ignores full-text ranking and deduplicates repeated source requests before joining the requested IDs.
