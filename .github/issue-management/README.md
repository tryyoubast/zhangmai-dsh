# Pull-request metadata and optional Issue Project automation

English | [中文](README.zh.md)

This reference defines the required PR metadata check and the opt-in Issue Project workflow. Preview publication has its own [configuration](../preview-sizing/README.md#publication-semantics).

## Required PR metadata

The required check remains `Issue policy`. It applies after a human, non-draft PR has a requested reviewer or any submitted review. Drafts, Bot/App authors, and PRs that have not entered review are exempt. The check requires exactly one allowed `kind/*` and at least one `area/*`; [label taxonomy](../../.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md) defines the kinds, extensible areas, and reserved aliases. `source/*` belongs only to Issues. Priority is optional: use zero or one lowercase `p0`, `p1`, `p2`, or `p3`; uppercase aliases are rejected.

Issue references in the PR body are optional. The check reads only live PR labels, requested reviewers, and submitted reviews through the triggering repository's read-only `GITHUB_TOKEN`; `GITHUB_REPOSITORY` identifies that repository. It does not read the PR body, Issues, Projects, or optional Project configuration. The normal `pull_request` job checks out the current event SHA with persisted credentials disabled; trusted review-write workflows keep their own execution policy.

<a id="optional-issue-project-integration"></a>

## Optional Issue Project integration

[Issue lifecycle](../workflows/issue-lifecycle.yml) is disabled unless repository variable `DSH_ISSUE_PROJECT_ENABLED` is exactly `true`. Disabled runs create no App token and make no Issue or Project calls. To enable it, configure [config.json](config.json) for the triggering repository and intended organization Project, then set variable `DSH_ISSUE_APP_CLIENT_ID` and secret `DSH_ISSUE_APP_PRIVATE_KEY` for an App with the required repository Issue and organization Project permissions. A configuration preflight rejects a different repository before token creation.

Enabled runs check out trusted default-branch code, exclude Bot/App senders and PR authors, and retain subscribed Issue and PR lifecycle events. Only submitted `changes_requested` reviews can create the lifecycle token; approved/commented reviews succeed without board mutations. The optional workflow owns Issue label repair and audits, [event-directed status transitions](../../.agents/notes/implemented/process/2026-08-10-event-directed-pr-review-status.md), and [Project-local planning fields](../../.agents/notes/implemented/process/2026-09-02-project-local-issue-planning-fields.md). It is independent of the required PR check and never creates Issues.

## Verification

Run `pnpm run test:issue-management` for pure metadata, read-only API, and optional lifecycle regressions. Run `pnpm exec vitest run scripts/issue-policy-workflow.spec.ts scripts/preview-workflow.spec.ts` to check workflow permissions, event/code selection, and opt-in credential handling. The [decision record](../../.agents/notes/implemented/process/2026-11-09-portable-pr-metadata-and-optional-project.md) explains the separation.
