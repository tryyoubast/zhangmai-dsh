/** Serialize local paid acceptance and persist conservative task reservations before HTTP submission. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** A fixed diagnostic that never includes provider responses or filesystem causes. */
export class RealBudgetError extends Error {}

/** Reservation held by the single process that owns the local acceptance lock. */
export interface RealBudgetLease {
  /** Persist the next submitted count; failed or interrupted submissions never refund it. */
  reserve(): Promise<void>
}

type Budget = Record<string, unknown> & { submitted: number; maximum: 2 }

function parseBudget(text: string): Budget {
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { throw new RealBudgetError('Real acceptance budget is not valid JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('maximum' in value) || value.maximum !== 2 || !('submitted' in value)
    || typeof value.submitted !== 'number' || !Number.isInteger(value.submitted)
    || value.submitted < 0 || value.submitted > 2) {
    throw new RealBudgetError('Real acceptance budget is malformed')
  }
  return { ...value, maximum: 2, submitted: value.submitted }
}

async function persist(path: string, value: Budget): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value) + '\n')
    await file.sync()
    await file.close()
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      // POSIX requires syncing the parent for a renamed reservation to survive a host crash.
      const directory = await open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await file.close()
    try { await unlink(temporary) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
}

/**
 * Exclude other acceptance and service-management operations from the shared worker.
 * @param state - Isolated local staging state directory.
 * @param callback - Work that owns the worker until cleanup completes.
 * @returns The callback result; an unrecognized existing lock is never removed.
 */
export async function withAcceptanceLock<T>(state: string, callback: () => Promise<T>): Promise<T> {
  const evidence = join(state, 'evidence')
  const lockPath = join(evidence, 'real-provider-budget.lock')
  await mkdir(evidence, { recursive: true })
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new RealBudgetError('Real acceptance budget is locked or unavailable; inspect the existing lock before manual recovery')
  })
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n')
    return await callback()
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

/**
 * Validate and reserve paid work while holding the shared acceptance lock.
 * @param state - Isolated local staging state directory.
 * @param resume - Require the existing one-of-two budget instead of creating a new campaign.
 * @param callback - Owner of reservations and provider changes until restoration completes.
 * @returns The callback result, without changing an existing budget on validation failure.
 */
export async function withRealBudget<T>(state: string, resume: boolean, callback: (lease: RealBudgetLease) => Promise<T>): Promise<T> {
  return withAcceptanceLock(state, async () => {
    const path = join(state, 'evidence', 'real-provider-budget.json')
    let saved: string | undefined
    try { saved = await readFile(path, 'utf8') } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw new RealBudgetError('Real acceptance budget cannot be read')
      }
    }
    if (!resume && saved !== undefined) throw new RealBudgetError('Real acceptance budget already exists; only an explicit --resume can use the remaining task')
    if (resume && saved === undefined) throw new RealBudgetError('Real acceptance resume budget is missing')
    let budget: Budget = saved === undefined ? { submitted: 0, maximum: 2 } : parseBudget(saved)
    if (resume && budget.submitted !== 1) throw new RealBudgetError('Real acceptance resume budget must contain exactly one remaining task')
    return await callback({
      async reserve() {
        if (budget.submitted >= budget.maximum) throw new RealBudgetError('Real acceptance budget is exhausted')
        const next = { ...budget, submitted: budget.submitted + 1 }
        await persist(path, next)
        budget = next
      },
    })
  })
}

/** The original owner of a supplemental test novel. */
export interface SupplementFixture {
  readonly userId: string
  readonly workspaceId: string
  readonly novelId: string
}

/** Proof of the first paid result, recorded only after its drafts have been verified. */
export interface SupplementSeed extends SupplementFixture {
  readonly seedRunId: string
  readonly snapshotHash: string
  readonly instructionHash: string
  readonly model: string
}

/** Supplemental budget operations available only to the current lock owner. */
export interface SupplementLease {
  /** The verified seed required when resuming, or undefined on a new attempt. */
  readonly seed: SupplementSeed | undefined
  /** Charge exactly one task and persist its request key before any HTTP submission. */
  reserve(key: string): Promise<void>
  /** Save the verified first result before a restart or second reservation. */
  saveSeed(seed: SupplementSeed): Promise<void>
}

function parseSeed(value: unknown): SupplementSeed {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RealBudgetError('Supplemental budget checkpoint is malformed')
  }
  const fields = value as Record<string, unknown>
  const { userId, workspaceId, novelId, seedRunId, snapshotHash, instructionHash, model } = fields
  const hash = /^[a-f0-9]{64}$/u
  if (typeof userId !== 'string' || userId === '' || typeof workspaceId !== 'string' || workspaceId === ''
    || typeof novelId !== 'string' || novelId === '' || typeof seedRunId !== 'string' || seedRunId === ''
    || typeof snapshotHash !== 'string' || !hash.test(snapshotHash) || typeof instructionHash !== 'string' || !hash.test(instructionHash)
    || typeof model !== 'string' || model === '') throw new RealBudgetError('Supplemental budget checkpoint is malformed')
  return { userId, workspaceId, novelId, seedRunId, snapshotHash, instructionHash, model }
}

/**
 * Read the unique supplemental budget and serialize reservations with all staging management.
 * @param state - The existing staging state directory that owns both ledgers.
 * @param resume - Only allow continuation after a verified seed and one reserved task.
 * @param baseHash - The expected SHA-256 of the unchanged, exhausted historical ledger.
 * @param callback - Owns all reservations and worker changes until it settles.
 * @returns The callback result; validation failure never initializes or resets a ledger.
 */
export async function withSupplementBudget<T>(
  state: string, resume: boolean, baseHash: string, callback: (lease: SupplementLease) => Promise<T>,
): Promise<T> {
  return withAcceptanceLock(state, async () => {
    const evidence = join(state, 'evidence')
    const original = await readFile(join(evidence, 'real-provider-budget.json')).catch(() => {
      throw new RealBudgetError('Historical real acceptance budget cannot be read')
    })
    if (createHash('sha256').update(original).digest('hex') !== baseHash || parseBudget(original.toString('utf8')).submitted !== 2) {
      throw new RealBudgetError('Historical real acceptance budget does not match the exhausted ledger')
    }
    const path = join(evidence, 'real-provider-budget-supplement.json')
    const saved = await readFile(path, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new RealBudgetError('Supplemental budget cannot be read')
    })
    let budget: Budget = saved === undefined ? {
      schemaVersion: 1, maximum: 2, submitted: 0, baseBudgetSha256: baseHash, createdAt: new Date().toISOString(),
    } : parseBudget(saved)
    if (budget.schemaVersion !== 1 || budget.baseBudgetSha256 !== baseHash
      || typeof budget.createdAt !== 'string' || !Number.isFinite(Date.parse(budget.createdAt))
      || (budget.submitted === 0 ? budget.reservationKey !== undefined || budget.seed !== undefined
        : typeof budget.reservationKey !== 'string' || budget.reservationKey === '')) {
      throw new RealBudgetError('Supplemental budget is malformed')
    }
    let seed = budget.seed === undefined ? undefined : parseSeed(budget.seed)
    if (seed === undefined ? budget.seedReservationKey !== undefined || budget.submitted === 2
      : typeof budget.seedReservationKey !== 'string' || budget.seedReservationKey === ''
        || (budget.seedReservationKey === budget.reservationKey) !== (budget.submitted === 1)) {
      throw new RealBudgetError('Supplemental budget reservation history is malformed')
    }
    if (!resume && budget.submitted !== 0 || resume && budget.submitted !== 1) {
      throw new RealBudgetError('Supplemental budget does not allow this invocation')
    }
    if (resume && seed === undefined) throw new RealBudgetError('No verified seed checkpoint; supplemental recovery cannot submit a task')
    return await callback({
      seed,
      async reserve(key) {
        if (budget.submitted >= 2 || budget.submitted === 1 && (seed === undefined || key === budget.reservationKey)) {
          throw new RealBudgetError('Supplemental budget cannot reserve another task')
        }
        const next = { ...budget, submitted: budget.submitted + 1, reservationKey: key }
        await persist(path, next)
        budget = next
      },
      async saveSeed(verified) {
        if (budget.submitted !== 1 || seed !== undefined) throw new RealBudgetError('Supplemental checkpoint cannot be replaced')
        const next = { ...budget, seed: verified, seedReservationKey: budget.reservationKey }
        await persist(path, next)
        budget = next
        seed = verified
      },
    })
  })
}

/** Operations performed under the single remaining paid-task lease. */
export interface RemainingRealOperations {
  /** Check HTTPS, mock evidence and the provider without creating business data. */
  preflight(): Promise<void>
  /** Prepare fixed-model drafts and prove restart recovery before the paid task. */
  prepare(): Promise<void>
  /** Switch provider and submit exactly one generation request, without retries. */
  generate(): Promise<void>
  /** Check draft persistence and a second restart without another model request. */
  verify(): Promise<void>
  /** Restore and verify the fixed-model worker even after a failed stage. */
  restore(): Promise<void>
}

/**
 * Execute one paid task with failure cleanup and no budget refunds.
 * @param state - Existing isolated state whose budget is exactly one of two tasks.
 * @param operations - Stage operations; restoration runs only after obtaining the lease.
 * @returns Completion after successful verification and fixed-model restoration.
 */
export async function runRemainingRealAcceptance(state: string, operations: RemainingRealOperations): Promise<void> {
  await withRealBudget(state, true, async lease => {
    let failed = false, failure: unknown
    try {
      await operations.preflight()
      await operations.prepare()
      await lease.reserve()
      await operations.generate()
      await operations.verify()
    } catch (error) {
      failed = true
      failure = error
    }
    try { await operations.restore() } catch {
      throw new RealBudgetError(failed
        ? 'Real acceptance failed and fixed-model restoration failed'
        : 'Real acceptance fixed-model restoration failed')
    }
    if (failed) throw failure
  })
}
