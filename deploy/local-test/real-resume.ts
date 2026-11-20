/** Verify one real continuation after fixed-model preparation, with both restarts under the budget lease. */
import assert from 'node:assert/strict'
import { runRemainingRealAcceptance } from './real-budget.ts'

/** Credential-free persistence evidence used before and after restarts. */
export interface ResumeSnapshot {
  readonly workspaceId: string
  readonly status: string
  readonly savedResults: number
  readonly draftTargets: number
  readonly chapterNumbers: readonly number[]
  readonly proposals: readonly { readonly id: string; readonly targetType: string; readonly targetId: string; readonly status: string }[]
  readonly context: readonly { readonly sourceType: string; readonly sourceId: string; readonly rank: number; readonly excerptHash: string }[]
}

/** Safe locators for the independent fixed-model fixture. */
export interface ResumeFixture {
  readonly workspaceId: string
  readonly novelId: string
  readonly seedRunId: string
}

/** HTTPS, queue and provider controls supplied by the deployed acceptance runner. */
export interface ResumeHarness {
  /** Verify readiness, complete mock evidence, and the official model catalogue. */
  preflight(): Promise<void>
  /** Create an independent account/novel and complete fourteen fixed-model drafts. */
  prepareFixed(): Promise<ResumeFixture>
  /** Read seed locators and persisted counts using HTTP with read-only database supplements. */
  seedSnapshot(): Promise<ResumeSnapshot>
  /** Run worker-authorized production retrieval without persisting context or calling a model. */
  contextPreflight(instruction: string, limit: number): Promise<ResumeSnapshot['context']>
  /** Wait until all known notifications have been acknowledged. */
  drain(): Promise<void>
  /** Restart API and worker and await HTTPS readiness. */
  restart(): Promise<void>
  /** Recreate the worker using the real endpoint before reserving the paid request. */
  selectReal(): Promise<void>
  /** Submit one HTTPS generation request and await completion, without retries. */
  submit(instruction: string, limit: number): Promise<string>
  /** Read the generated result and exact persisted context selection. */
  generatedSnapshot(): Promise<ResumeSnapshot>
  /** Restore the fixed worker and verify its actual provider configuration. */
  restore(): Promise<void>
}

/** Exact continuation instruction shared by paid preparation and the keyless deployed regression. */
export const REAL_CONTINUATION_INSTRUCTION = 'Continue the saved Moon Harbor story context. Return only JSON with records: one new character named Lantern Courier (targetType characters, name, summary), one new location named Lantern Pier (targetType locations, name, summary), and chapter 2 (targetType chapters, chapterNo:2, title:Moon Harbor Continuation, summary). Keep the combined prose under 120 words. Drafts only; do not update or publish existing records.'

/** Redacted failure stage and the durable locators known before failure. */
export class ResumeFlowError extends Error {
  override readonly name = 'ResumeFlowError'

  constructor(
    readonly stage: string,
    readonly locators: Partial<ResumeFixture> & { readonly runId?: string },
  ) {
    super(`Real continuation failed: ${stage}`)
  }
}

function stableSnapshot(snapshot: ResumeSnapshot): ResumeSnapshot {
  // Proposal queries have no ordering guarantee; context ordering is model-visible and must stay exact.
  return { ...snapshot, proposals: [...snapshot.proposals].sort((left, right) => left.id.localeCompare(right.id)) }
}

function assertGenerated(snapshot: ResumeSnapshot, workspaceId: string): void {
  assert.equal(snapshot.workspaceId, workspaceId)
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.savedResults, 1)
  assert(snapshot.draftTargets >= 3)
  assert(snapshot.chapterNumbers.includes(2), 'The real continuation must persist chapter 2')
  const types = new Set(snapshot.proposals.map(proposal => proposal.targetType))
  for (const type of ['characters', 'locations', 'chapters']) assert(types.has(type))
  assert(snapshot.proposals.every(proposal => proposal.id !== '' && proposal.targetId !== '' && proposal.status === 'draft'))
  assert(snapshot.context.length > 0)
}

/**
 * Consume the sole remaining task only after fixed preparation and a restart have succeeded.
 * @param state - Isolated staging state with a one-of-two budget.
 * @param harness - Deployed transport and process controls; tests inject a simulated provider.
 * @returns Credential-free fixture and real-run locators after the second restart and worker restoration.
 */
export async function executeRemainingRealFlow(state: string, harness: ResumeHarness): Promise<ResumeFixture & { readonly runId: string; readonly preparationProvider: 'fixed-model' }> {
  let fixture: ResumeFixture | undefined, before: ResumeSnapshot | undefined, runId: string | undefined
  let restorationFailure: ResumeFlowError | undefined
  async function checked<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch {
      throw new ResumeFlowError(stage, { ...fixture, ...(runId === undefined ? {} : { runId }) })
    }
  }
  await runRemainingRealAcceptance(state, {
    preflight: () => checked('preflight', () => harness.preflight()),
    async prepare() {
      fixture = await checked('fixed-preparation', () => harness.prepareFixed())
      const seed = await checked('seed-persistence', async () => {
        assert(fixture !== undefined)
        const snapshot = stableSnapshot(await harness.seedSnapshot())
        assert.equal(snapshot.workspaceId, fixture.workspaceId)
        assert.equal(snapshot.status, 'completed')
        assert.equal(snapshot.savedResults, 1)
        assert.equal(new Set(snapshot.proposals.map(proposal => proposal.targetType)).size, 14)
        assert.equal(snapshot.draftTargets, 14)
        assert(snapshot.proposals.every(proposal => proposal.status === 'draft' && proposal.targetId !== ''))
        return snapshot
      })
      await checked('seed-restart', async () => {
        await harness.drain()
        await harness.restart()
        assert.deepEqual(stableSnapshot(await harness.seedSnapshot()), seed)
      })
      await checked('context-preflight', async () => {
        const selected = await harness.contextPreflight(REAL_CONTINUATION_INSTRUCTION, 8)
        assert(selected.length > 0, 'Continuation requires nonempty historical context before a paid reservation')
      })
      await checked('provider-selection', () => harness.selectReal())
    },
    async generate() {
      assert(fixture !== undefined)
      runId = await checked('submission', () => harness.submit(REAL_CONTINUATION_INSTRUCTION, 8))
      await checked('generated-persistence', async () => {
        assert(fixture !== undefined)
        before = stableSnapshot(await harness.generatedSnapshot())
        assertGenerated(before, fixture.workspaceId)
      })
    },
    async verify() {
      assert(fixture !== undefined && before !== undefined)
      await checked('generated-restart', async () => {
        assert(fixture !== undefined)
        await harness.drain()
        await harness.restart()
        const after = stableSnapshot(await harness.generatedSnapshot())
        assertGenerated(after, fixture.workspaceId)
        assert.deepEqual(after, before)
      })
    },
    async restore() {
      try { await checked('restoration', () => harness.restore()) } catch (error) {
        // The budget owner deliberately redacts cleanup errors; retain our safe locators separately.
        if (error instanceof ResumeFlowError) restorationFailure = error
        throw error
      }
    },
  }).catch((error: unknown) => {
    if (restorationFailure !== undefined) throw restorationFailure
    if (error instanceof ResumeFlowError || fixture === undefined) throw error
    // Reservation and lock-release failures occur outside the harness callbacks.
    throw new ResumeFlowError('budget-lease', { ...fixture, ...(runId === undefined ? {} : { runId }) })
  })
  assert(fixture !== undefined && runId !== undefined)
  return { ...fixture, runId, preparationProvider: 'fixed-model' }
}
