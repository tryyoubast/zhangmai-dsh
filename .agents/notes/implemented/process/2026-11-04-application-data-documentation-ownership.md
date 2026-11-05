# Agent Note: Application data documentation ownership

Status: implemented

English | [中文](2026-11-04-application-data-documentation-ownership.zh.md)

## Problem

Application database, authentication, and novel authoring packages lack complete public JSDoc and use plugin-oriented README classifications despite exporting ordinary library APIs. The HTTP plugin's injected controller also lacks catalog ownership. These gaps block documentation checks and make runtime composition, database authority, and model-visible generation input harder to establish from the owning references.

## Decision

Public declarations carry implementation-grounded parameter, result, transaction, and ownership documentation. The PostgreSQL, authentication, and novel authoring packages use the library README form and the audited library registry; the HTTP adapter retains the plugin form with its actual injected dependencies. The database subsystem owns pool lifetime, trusted RLS identity, and deployment/runtime role separation. The HTTP subsystem owns the injected platform controller and its request/response types.

The database, authentication, and HTTP adapter READMEs use the audited short Model Experience form because their direct responsibilities construct no model request. The authoring README uses structured entries for the DeepSeek adapter's fixed system instruction and dynamic user JSON, including token growth and provider-owned caching. Source-derived catalogs are regenerated after JSDoc changes, including source-line references and the runtime Cordis catalog.

These package-specific registrations apply the existing [README classification](../../../skills/dsh-doc/SKILL.md), [Model Experience](2026-07-12-package-model-experience-contract.md), and [Agent Note format](2026-07-05-uniform-agent-note-format.md) policies. Those independently useful policy decisions remain active. The new database reference stays repository-only; existing website routes retain their publication policy.

## Alternatives considered

**Skip failing checks or add broad exemptions.** This conceals missing documentation and permits new exports or services to lose their owner without detection. The existing checks and their rejection cases remain enforced.

**Describe every package as a plugin.** Libraries have no mount entry. Plugin installation instructions would imply an activation path that the module exports cannot provide.

**Use a model-agnostic sentence for novel generation.** The DeepSeek adapter sends prompts and serialized context itself. A short classification would hide actual model input and request-size growth.

**Assign application PostgreSQL to the generic KV page.** The two stores have different data, role, and transaction responsibilities. A direct database reference preserves that distinction without duplicating SQL declarations.

## Consequences

Source comments and reviewed classification tables own the facts consumed by documentation generators. English and Chinese pages update together with explicit pairing records. API signatures, business behavior, migration SQL, and dependency versions remain unchanged; generated catalogs reflect the already-declared controller and its documented methods.

Verification uses the export JSDoc check, README and catalog tests, translation pairing, complete `doc-sync`, TypeScript, lint, and website projection/build checks. Static tests establish document and generator consistency; this documentation repair does not establish new production database or provider behavior.
