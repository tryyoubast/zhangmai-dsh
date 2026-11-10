# Agent Note: Synchronize fixtures on owned resources

Status: implemented

English | [中文](2026-11-10-host-resource-fixture-synchronization.zh.md)

## Problem

A released port probe does not reserve the successor port for a Worker. On Windows, another process can claim that port for an outbound connection before the Worker binds. Polling a persisted file can also hold a read handle while its writer replaces it, causing Windows sharing failures. A subsecond provider timeout in a process smoke includes serialization and connection startup, so it can measure host scheduling instead of heartbeat handling.

## Decision

The [inspector port cases](../../../../packages/experimental/inspector/tests/port-selection.host.spec.ts) inject listen errors to assert the exact occupied-port increment sequence and fatal permission-error behavior. Successful listeners bind port zero atomically. A separate real Worker case checks publication of the kernel-assigned port in every endpoint and verifies HTTP reachability.

The [projection-cache cases](../../../../packages/session/session-projection-cache/tests) observe the existing durable storage notification before opening the persisted document for comparison. They subscribe before triggering the write and match the target record and expected value, so a creation checkpoint cannot satisfy a later rewrite. The assertions still inspect the on-disk identity and projection data; they do not compete with the writer's atomic rename.

The [headless provider smoke](../../../../apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts) inherits the shipped stream-idle timeout, sends a comment with the response headers, and keeps the main response open until the title request arrives. It requires the expected two requests, provider defaults, comments, final output, and absence of retry events. The provider's fake-timer unit test owns the precise heartbeat deadline and propagates abort through its mocked response body, making missing activity resets observable.

The [hosted-image assumptions](2026-09-10-hosted-image-test-assumptions.md) and [recorded-session corpus](2026-08-24-session-log-snapshot-corpus.md) decisions remain active: their containment, platform, replay, and fixture-placement rules are independent of these resource-acquisition and completion rules.

## Alternatives considered

**Probe an available successor, then release it before startup.** Availability can change between those operations; probing another candidate only moves the same race.

**Poll the document until its contents match.** A polling reader can prevent the very rename it awaits on Windows. The storage notification supplies the existing completion signal without holding a competing file handle.

**Increase retries, widen assertions, or impose global serialization.** Those choices hide the resource race or missing observation. Exact request and data assertions remain, and independent test processes retain private resources.

**Keep a strict subsecond timeout in the process smoke.** Process startup and request preparation are outside a controlled clock. The deterministic provider test checks deadline behavior while the process smoke checks the assembled application.

## Consequences

The tests retain real network and durable-file evidence while separating host resource allocation from deterministic error and clock behavior. Production retry, permission-error, timeout, and cache-write policies remain unchanged. Every fixture owns and awaits cleanup of its listener, Worker, subscription, or storage context; completion waits are bounded for failure reporting rather than used as readiness delays.
