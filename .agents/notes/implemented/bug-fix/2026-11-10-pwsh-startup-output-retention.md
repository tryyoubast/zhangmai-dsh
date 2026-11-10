# Agent Note: Retain PowerShell startup output across readiness probes

Status: implemented

English | [中文](2026-11-10-pwsh-startup-output-retention.zh.md)

## Problem

PowerShell startup can span a silence-settled send and a later exact readiness probe. Output arriving between those operations reaches retained scrollback but belongs to neither send's viewport. Publishing only the final viewport can therefore return an empty startup message even when the shell has printed its controlled prompt.

## Decision

The [shell backend](../../../../packages/terminal/terminal-bash/src/index.ts) reads the existing bounded scrollback when it publishes a PowerShell session. The final `stdin_read` result still decides readiness; retained text supplies the startup message without creating another output accumulator or extending any deadline. The ordinary read limits also bound that message.

The [persistent-terminal decision](../feature/2026-07-16-persistent-pty-sessions.md) retains ownership, teardown and readiness policy. The [PowerShell CI decision](../testing/2026-09-07-pwsh-ci-observable-completion.md) retains execution proofs after inferred settlement and recorded-profile expectations; neither decision is superseded by startup-message retention.

## Alternatives considered

**Concatenate settled send viewports.** This still loses output arriving when no send collects it and requires another bounded accumulator already owned by the session.

**Increase the silence timeout or accept an empty message.** A larger timing window cannot make operation-local output cover every startup interval. Accepting an empty message hides retained output from the caller.

## Consequences

The startup message includes retained output from earlier probes and their gaps, subject to existing line and byte limits. A controlled-clock regression uses the real session, emits the prompt between probes, and verifies both retained output and the published message. Removing the retention read reproduces the empty-message failure. Readiness classification, cancellation, startup timeout and credential scrubbing remain independently enforced.
