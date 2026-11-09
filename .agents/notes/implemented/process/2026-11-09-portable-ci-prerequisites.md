# Agent Note: Portable CI runners and publication prerequisites

Status: implemented

English | [中文](2026-11-09-portable-ci-prerequisites.zh.md)

## Problem

Required pull-request checks cannot assume access to an organization's larger runner labels. Standard hosted machines also need smaller process budgets than the enterprise pools. Authoring package manifests must satisfy the repository's existing Cordis and publication rules before those checks can validate application changes.

## Decision

[Pull-request CI](../../../../.github/workflows/ci.yml) defaults to GitHub-hosted `ubuntu-24.04` and `windows-2025`. `DSH_CI_RUNNER_PROFILE=enterprise` selects the existing larger Linux and Windows primary pools. Each platform's `blacksmith` or eligible `selfhosted` failover takes precedence over the profile. Dependabot remains excluded from persistent pools and falls back to the selected hosted profile. Compatibility and verdict jobs retain standard hosted capacity outside failover.

Standard hosted coverage uses two single-worker instrumented partitions, one exempt worker, and gate concurrency one. Other heavy aggregates and their explicitly configured lint, publication, browser, and snapshot workers use two. Enterprise and failover runners retain their existing budgets, including the self-hosted Linux snapshot limit. The [failover runbook](2026-07-26-ci-failover-runbook.md), [Blacksmith decision](2026-09-09-blacksmith-failover-leg.md), and [native Windows decision](2026-08-08-native-windows-pull-request-ci.md) remain active for trust restrictions, pool recovery, and platform validation; this note owns default selection and standard hosted budgets.

The database, authentication, authoring, and authoring HTTP packages declare matching `workspace:^` Cordis peer and development dependencies. The HTTP package carries public publication metadata. The [database payload policy](../../../../scripts/check-workspace-constraints.ts) admits only root migration SQL files, the migration journal, and the two named deployment scripts beside built artifacts. Drizzle configuration, source, snapshot metadata, and maps remain excluded; unrelated package payload rules do not change.

## Alternatives considered

**Require enterprise runner labels everywhere.** This leaves repositories without those labels unable to complete required checks.

**Reuse enterprise concurrency on standard hosted runners.** Coverage partitions and concurrent tool processes compete for a smaller CPU and memory allocation. Separate budgets preserve the enterprise configuration while bounding standard hosted work.

**Publish whole database source or script directories.** The controlled migration entry imports built JavaScript and needs only its SQL journal and reviewed scripts. Broader directories would admit unrelated source or future deployment helpers without review.

## Consequences

Required coverage also exercises migration resource cleanup, authentication failures, authoring validation, and HTTP error paths. Validated array results and route segments carry their complete types, and exhaustive target switches retain compiler return-flow checks. Removing unreachable duplicate checks avoids tests that fabricate impossible parser states; unsupported targets, malformed credentials, tenant violations, and invalid payloads still have executable rejection tests. Coverage thresholds and exclusions stay fixed.

Standard hosted validation trades parallel throughput for portable scheduling. Workflow tests evaluate default, enterprise, failover, and Dependabot routing and resource budgets; manifest tests reject broad database payload additions while preserving source and map rejection. These checks establish configuration behavior; platform runtime and exhaustive coverage evidence remain CI responsibilities. Existing failover and native Windows notes are partially superseded only in their default runner and resource descriptions, so their independent operational rationale stays active.
