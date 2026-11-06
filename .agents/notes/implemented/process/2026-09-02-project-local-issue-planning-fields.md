# Agent Note: Project-local Issue planning fields

Status: implemented

English | [中文](2026-09-02-project-local-issue-planning-fields.zh.md)

## Problem

The optional Issue lifecycle workflow needs structured planning metadata, but organization Issue fields require a separate GitHub App permission from organization Projects. A workflow token with Project write access can read and update Project custom fields while GitHub rejects Issue-field reads, so using both storage systems makes one policy depend on two independently administered permission sets.

Priority, impact, cost, and dates are used to plan work in `DSH Issue Management`. Keeping those values on the Issue also exposes them outside that Project, but the repository has no workflow that needs cross-Project values.

## Decision

The `DSH Issue Management` Project owns `Priority`, `Severity`, `Cost`, `Start Date`, and `Target Date` as Project custom fields. `Severity` uses the option meanings from the organization `影响面` field, and `Cost` uses the option meanings from `解决代价`.

The required pull-request policy reads pull-request state and labels only; Issue references are optional and do not trigger Issue or Project reads. A PR's optional `p0`–`p3` label is its priority source. Project `Priority` is used only to plan Issues and is never inferred into a PR label. When Project lifecycle automation is enabled, the lifecycle workflow resolves `Priority` and `Start Date` from the configured Project, rejects an Issue-backed field or the wrong data type, reads Priority from the Project item, and writes Start Date through `updateProjectV2ItemFieldValue`. Organization Issue fields are retained only as `Legacy ...` migration sources and are not read by repository workflows.

The pull-request policy workflow checks out the default branch with persisted checkout credentials disabled and uses only repository-scoped read permissions; it does not mint a GitHub App token. Project lifecycle automation is disabled unless `DSH_PROJECT_AUTOMATION_ENABLED == 'true'`. When enabled, the workflow validates that the configured organization/repository matches `GITHUB_REPOSITORY` and that the Project fields, statuses, number, and time zone are complete before using the configured App client ID and private key to mint the lifecycle token.

The Issue lifecycle workflow initializes `Start Date` only for `pull_request.opened`. It reads the pull request's live body, retains every same-repository reference that resolves to an Issue, converts `created_at` to a calendar date in the configured Project time zone, ensures the Issue is a Project item, and writes the date only when the current Project value is empty.

The [organization-field implementation](../../archived/process/2026-08-31-pr-opened-issue-start-dates.md) records the superseded cross-Project ownership decision and its event-timing rationale. Event-directed Status transitions remain owned by [the lifecycle decision](2026-08-10-event-directed-pr-review-status.md); current runner and optional-integration defaults are recorded in the [independent-repository CI decision](2026-11-05-independent-repository-ci.md).

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) require Project custom fields for Issue Priority and Start Date, cover the Shanghai date boundary, opened-only dispatch, empty-value writes, existing-value preservation, and missing Project items, and pin `updateProjectV2ItemFieldValue`. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the default-off Project token, matching-repository configuration, required credentials, fork and Dependabot skips, and PR-only read access. Removing an organization field requires comparing every legacy value with its Project value, including archived Project items.

## Alternatives considered

**Keep organization Issue fields.** They make one value visible across Projects, but the workflow does not need that scope and the GitHub App would require separate organization Issue Fields access.

**Dual-write Issue and Project fields.** Mirrored fields retain cross-Project visibility, but every writer and manual edit can create drift and requires a reconciliation policy.

**Process every subscribed pull-request event or overwrite Start Date.** Later events could repair missing dates, but they would assign dates after work starts or replace a manual plan. The initializer therefore retains opened-only, empty-only behavior.

## Consequences

Planning metadata is scoped to one Project membership. The same Issue can have different values in another Project, and an Issue outside `DSH Issue Management` has no Project-local planning values.

Enabled Project lifecycle automation needs Project access rather than organization Issue Fields access for Project metadata. Field renames or type changes fail the workflow instead of falling back to legacy fields; the default pull-request policy does not require Project credentials.

The empty-value read makes ordinary retries idempotent. Project field updates have no compare-and-set precondition, so simultaneous pull requests can both observe an empty Start Date and the last mutation can win.
