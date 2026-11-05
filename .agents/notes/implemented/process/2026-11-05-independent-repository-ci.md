# Agent Note: Independent-repository CI defaults and optional integrations

Status: implemented

English | [中文](2026-11-05-independent-repository-ci.zh.md)

## Problem

Pull-request checks need dependable standard hosted capacity while preserving a recovery path for runner outages. Preview deployment and Project automation also depend on repository-specific write credentials that cannot be available to fork pull requests.

Defaults that require large runners or external application credentials make routine checks costly and couple repository policy to optional integrations. The workflows need to keep validation available without granting untrusted changes deployment or Project write access.

## Decision

The primary pull-request Linux jobs use GitHub-hosted `ubuntu-24.04`; native Windows jobs use `windows-2025`. Standard-runner profiles use modest gate concurrency, two instrumented coverage partitions, and a snapshot concurrency cap of two. The existing `DSH_CI_FAILOVER_LINUX` and `DSH_CI_FAILOVER_WINDOWS` switches still route participating jobs to the in-house pools with `selfhosted` or to Blacksmith with `blacksmith`; the self-hosted trust conditions and Dependabot hosted fallback remain in force. The [failover runbook](2026-07-26-ci-failover-runbook.md) owns recovery details, and the [native Windows CI note](2026-08-08-native-windows-pull-request-ci.md) retains platform-specific execution rationale.

The `all checks passed` inventory retains the required PostgreSQL 18 auth job and its existing Linux, Windows, Node compatibility, and Python dependencies. CI, security, and review checks keep their existing roles. Master self-hosted standby jobs run only on master pushes when `DSH_SELFHOSTED_STANDBY_ENABLED == 'true'`; they remain diagnostic evidence and do not enter the pull-request check panel. Weighted human approval and reviewer ownership remain unchanged under the [approval policy](../../../../.github/review-ownership/README.md) and [weighted approval decision](2026-09-09-blocked-weighted-approvals-remain-pending.md).

The [Cloudflare preview workflow](../../../../.github/workflows/build-preview-cloudflare.yml) always builds and validates pull requests on `ubuntu-24.04`. Its exact `cloudflare pages preview` check is build-only. Deployment requires `DSH_PREVIEW_DEPLOY_ENABLED == 'true'`, a same-repository pull request, a matching Cloudflare target, and the configured deployment secrets. Fork pull requests never deploy and receive a build-only summary.

The [Issue policy workflow](../../../../.github/workflows/issue-policy.yml) checks out the repository default branch with persisted checkout credentials disabled and uses read-only current-repository REST access for pull-request and Issue policy. The [Issue lifecycle workflow](../../../../.github/workflows/issue-lifecycle.yml) keeps its Project App token path disabled unless `DSH_PROJECT_AUTOMATION_ENABLED == 'true'`; when enabled, required repository and Project configuration must match `GITHUB_REPOSITORY`, and the App client ID and private key must be configured. Project mutations skip fork pull requests and their review events; the default PR policy remains repository-only.

## Verification

[CI routing tests](../../../../scripts/tests/ci-runner-defaults.spec.ts) and [workflow tests](../../../../scripts/ci-workflow.spec.ts) pin standard defaults, failover routing, required checks, and standby opt-in. [Preview workflow tests](../../../../scripts/preview-workflow.spec.ts) pin build-only validation and same-repository deployment conditions. Issue-management tests cover repository policy and opt-in Project lifecycle configuration and mutations.

## Alternatives considered

- **Use larger hosted runners for every pull request.** They can shorten measured job times, but spend larger-runner capacity on routine work and make the required path depend on a specialized pool; the existing switches retain larger-capacity failover.
- **Run master standbys on every master push.** Continuous drills produce more readiness data, but consume shared in-house capacity when the operator has not enabled it; the explicit switch keeps those jobs opt-in.
- **Deploy every preview, including fork pull requests.** This gives every change a preview URL, but gives untrusted pull-request code access to deployment credentials; unconditional builds keep validation while same-repository opt-in gates writes.
- **Make Project integration mandatory for pull-request policy.** This gives policy access to board fields, but requires every repository to configure an App and Project and makes a read-only check depend on an external target; repository REST remains the self-contained default while lifecycle writes stay optional.

## Consequences

Routine pull-request checks run on standard GitHub-hosted images with bounded concurrency, while higher-capacity routing remains an explicit recovery choice. The standard profile can take longer than the measured larger-runner profile, and an operator must enable and monitor master standbys before using their results as readiness evidence.

Every pull request still receives preview build validation, but forks receive no deployed URL. Repositories that enable Cloudflare or Project automation must maintain matching target configuration and credentials. Project lifecycle dates and field changes remain inactive until that setup is enabled; repository-only Issue policy and weighted human approval do not depend on it.
