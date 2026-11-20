/** Verify two paid tasks under the same staging budget, with an optional seed checkpoint. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { withSupplementBudget, type SupplementFixture, type SupplementSeed } from './real-budget.ts'
import { REAL_CONTINUATION_INSTRUCTION, type ResumeSnapshot } from './real-resume.ts'

const SEED_INSTRUCTION = 'Return only JSON with records: one character named Lin (targetType characters, name, summary), one location named Moon Harbor (targetType locations, name, summary), and chapter 1 (targetType chapters, chapterNo:1, title:Moon Harbor, summary). Set the story in Moon Harbor. Keep the combined prose under 120 words. Drafts only.'
const LIMIT = 8
const sourceTypes = new Map([['characters', 'character'], ['locations', 'location'], ['chapters', 'chapter']])

/** HTTPS, persistence and worker operations owned by the deployed acceptance runner. */
export interface SupplementHarness {
  /** Verify current mock evidence, HTTPS and the selected provider model. */
  preflight(): Promise<void>
  /** Create a new account and empty novel, saving login material separately. */
  prepare(): Promise<SupplementFixture>
  /** Reauthenticate the original test owner and check the workspace identity. */
  attach(fixture: SupplementFixture): Promise<void>
  /** Wait until the staging broker has no pending messages or lag. */
  drain(): Promise<void>
  /** Restart the API and current worker and wait for HTTPS. */
  restart(): Promise<void>
  /** Execute read-only retrieval as the restricted worker identity of the seed. */
  contextPreflight(seedRunId: string, instruction: string, limit: number): Promise<ResumeSnapshot['context']>
  /** Recreate and verify the real endpoint and configured model. */
  selectReal(): Promise<void>
  /** Submit once using the pre-reserved idempotency key and wait for completion. */
  submit(instruction: string, limit: number, key: string): Promise<string>
  /** Read persisted task, draft and context data, checking the named targets for the chapter. */
  snapshot(runId: string, chapter: 1 | 2): Promise<ResumeSnapshot>
  /** Restore and verify the actual fixed-model worker. */
  restore(): Promise<void>
}

/** Redacted evidence for a failed supplemental stage and independently failed cleanup. */
export class SupplementFlowError extends Error {
  override readonly name = 'SupplementFlowError'

  constructor(
    readonly stage: string,
    readonly locators: Partial<SupplementFixture> & { readonly seedRunId?: string; readonly runId?: string },
    readonly restorationFailed = false,
    readonly submitted = 0,
  ) {
    super(`Supplemental real acceptance failed: ${stage}`)
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function verifiedSnapshot(snapshot: ResumeSnapshot, workspaceId: string, chapter: 1 | 2): ResumeSnapshot {
  assert.equal(snapshot.workspaceId, workspaceId)
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.savedResults, 1)
  assert.equal(snapshot.draftTargets, 3)
  assert.deepEqual(snapshot.chapterNumbers, [chapter])
  assert.equal(snapshot.proposals.length, sourceTypes.size)
  assert.deepEqual(new Set(snapshot.proposals.map(proposal => proposal.targetType)), new Set(sourceTypes.keys()))
  assert(snapshot.proposals.every(proposal => proposal.status === 'draft' && proposal.targetId !== '' && proposal.id !== ''))
  if (chapter === 1) assert.deepEqual(snapshot.context, [])
  return { ...snapshot, proposals: [...snapshot.proposals].sort((left, right) => left.id.localeCompare(right.id)) }
}

/**
 * Spend a supplemental allowance on a fresh seed and continuation, or resume only the continuation.
 * @param state - Existing local staging state directory.
 * @param resume - Require a verified seed from the first invocation.
 * @param baseHash - Expected digest of the exhausted historical ledger.
 * @param model - Provider model verified by the caller's preflight and worker checks.
 * @param harness - Operations for the same isolated staging project.
 * @returns Safe locators and verified context after both restart checks and worker restoration.
 */
export async function executeRealSupplement(state: string, resume: boolean, baseHash: string, model: string, harness: SupplementHarness) {
  let fixture: SupplementFixture | undefined, seedRunId: string | undefined, runId: string | undefined
  let stage = 'budget', restorationFailed = false, submitted = 0
  const instructionHash = digest(REAL_CONTINUATION_INSTRUCTION)
  try {
    return await withSupplementBudget(state, resume, baseHash, async lease => {
      async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
        stage = name
        return await operation()
      }
      let checkpoint: SupplementSeed | undefined = lease.seed
      let failed = false
      try {
        if (checkpoint !== undefined) {
          stage = 'checkpoint'
          submitted = 1
          const { userId, workspaceId, novelId } = checkpoint
          fixture = { userId, workspaceId, novelId }
          seedRunId = checkpoint.seedRunId
          assert.equal(checkpoint.model, model)
          assert.equal(checkpoint.instructionHash, instructionHash)
        }
        await step('preflight', () => harness.preflight())
        if (checkpoint === undefined) {
          fixture = await step('fixture', () => harness.prepare())
          await step('seed-provider', async () => { await harness.drain(); await harness.selectReal() })
          const key = randomUUID()
          await step('seed-reservation', () => lease.reserve(key))
          submitted = 1
          seedRunId = await step('seed-submission', () => harness.submit(SEED_INSTRUCTION, 0, key))
          stage = 'seed-persistence'
          const seed = verifiedSnapshot(await harness.snapshot(seedRunId, 1), fixture.workspaceId, 1)
          const verified: SupplementSeed = { ...fixture, seedRunId, model, instructionHash, snapshotHash: digest(JSON.stringify(seed)) }
          await step('seed-checkpoint', () => lease.saveSeed(verified))
          checkpoint = verified
        } else {
          const originalOwner = fixture
          assert(originalOwner !== undefined)
          await step('recovery-login', () => harness.attach(originalOwner))
        }
        const seed = checkpoint
        await step('seed-restart', async () => {
          await harness.restore()
          await harness.drain()
          await harness.restart()
        })
        stage = 'seed-restart'
        const recovered = verifiedSnapshot(await harness.snapshot(seed.seedRunId, 1), seed.workspaceId, 1)
        assert.equal(digest(JSON.stringify(recovered)), seed.snapshotHash)
        stage = 'context-preflight'
        const selected = await harness.contextPreflight(seed.seedRunId, REAL_CONTINUATION_INSTRUCTION, LIMIT)
        assert(selected.length > 0 && selected.length <= LIMIT && selected.every((item, index) => item.rank === index
          && recovered.proposals.some(proposal => proposal.targetId === item.sourceId && sourceTypes.get(proposal.targetType) === item.sourceType)))
        await step('continuation-provider', async () => { await harness.drain(); await harness.selectReal() })
        const key = randomUUID()
        await step('continuation-reservation', () => lease.reserve(key))
        submitted = 2
        const continued = await step('continuation-submission', () => harness.submit(REAL_CONTINUATION_INSTRUCTION, LIMIT, key))
        runId = continued
        stage = 'continuation-persistence'
        const result = verifiedSnapshot(await harness.snapshot(continued, 2), seed.workspaceId, 2)
        assert.deepEqual(result.context, selected)
        await step('continuation-restart', async () => {
          await harness.restore()
          await harness.drain()
          await harness.restart()
          assert.deepEqual(verifiedSnapshot(await harness.snapshot(continued, 2), seed.workspaceId, 2), result)
        })
        stage = 'budget-release'
        return { userId: seed.userId, workspaceId: seed.workspaceId, novelId: seed.novelId, seedRunId: seed.seedRunId,
          runId: continued, seedSnapshotHash: seed.snapshotHash, continuationSnapshotHash: digest(JSON.stringify(result)), context: result.context }
      } catch (error) {
        failed = true
        throw error
      } finally {
        try { await harness.restore() } catch {
          restorationFailed = true
          if (!failed) {
            stage = 'restoration'
            throw new Error('Fixed worker restoration failed')
          }
        }
      }
    })
  } catch (error) {
    if (stage === 'budget') throw error
    throw new SupplementFlowError(stage, { ...fixture, ...(seedRunId === undefined ? {} : { seedRunId }),
      ...(runId === undefined ? {} : { runId }) }, restorationFailed, submitted)
  }
}
