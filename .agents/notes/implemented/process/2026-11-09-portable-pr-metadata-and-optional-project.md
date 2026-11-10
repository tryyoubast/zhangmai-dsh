# Agent Note: Portable PR metadata and optional Project automation

Status: implemented

English | [中文](2026-11-09-portable-pr-metadata-and-optional-project.zh.md)

## Problem

A required label check that reads organization Project planning fields needs an independently installed GitHub App and configured board. That dependency prevents an otherwise self-contained repository or fork from validating reviewed PRs and couples review classification to planning data outside the PR.

Issue status projection and planning dates still serve repositories that deliberately operate that Project. Their write permissions require trusted code and an explicit target, independently of PR label validation.

## Decision

The [PR policy reference](../../../../.github/issue-management/README.md) owns enforcement, labels, optional references, and opt-in configuration. The required check keeps its `Issue policy` name and review exemptions. A pure metadata module supplies label validation; its read-only entry point reads PR and review metadata from the triggering repository without importing Project configuration or parsing Issue references.

Optional Issue Project automation retains its lifecycle APIs and trusted default-branch checkout. Its explicit enablement and repository preflight occur before App-token creation. This separates installation-specific writes from the repository-local required check while preserving the [Project-local field decision](2026-09-02-project-local-issue-planning-fields.md) for enabled lifecycle operations.

The required check uses current-event code on ordinary `pull_request` runs with a read-only repository token. This makes policy edits reviewable on the PR itself. Workflows that publish trusted review decisions retain their separate trusted-code and write-token rules.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) cover label rejections and exemptions, accept absent Issue references and independent priorities, and reject uppercase Priority aliases. [Read-only API tests](../../../../.github/issue-management/pr-policy.test.mjs) reject every Issue/Project request and verify the configured repository token is the only credential used; an isolated import proves the mandatory modules load without Project configuration. [Workflow tests](../../../../scripts/issue-policy-workflow.spec.ts) pin the required-check name, current-event checkout, read-only permissions, explicit opt-in, preflight ordering, trusted lifecycle checkout, and permitted event range.

## Alternatives considered

**Require the Project App on every repository.** This preserves PR-to-Issue priority synchronization, but a reviewed PR cannot validate labels until administrators install organization infrastructure unrelated to the change.

**Remove Issue Project automation.** This eliminates configuration and write permissions, but gives up useful status projection and opened-only planning dates for repositories that operate the board.

**Run PR policy only from the default branch.** Trusted code is appropriate for write-capable review workflows, but a read-only label check would not exercise a proposed policy edit until after it merges.

## Consequences

The required check is portable without an organization Project or App secret. It does not prove that a PR has a planning Issue or that its priority matches board values; those relationships remain a review and planning decision. Operators must deliberately configure and enable Project automation, and default-off runs do not repair labels, update dates, or project status.
