import { rankContextCandidates } from './index.ts'
import type {
  ContextCandidate,
  GenerationContextSelectionInput,
  LongformAuthoringService,
} from './index.ts'

/** A query for candidates that is always scoped to one workspace and novel. */
export interface ContextCandidateQuery {
  readonly workspaceId: string
  readonly novelId: string
  readonly instruction: string
}

/** Host-owned retrieval seam for persisted novel context. */
export interface PersistedContextCandidateRepository {
  findCandidates(query: ContextCandidateQuery): Promise<readonly ContextCandidate[]>
  /** Rehydrate source excerpts for a previously recorded context selection. */
  hydrateContext?(input: {
    readonly workspaceId: string
    readonly novelId: string
    readonly items: readonly PersistedGenerationContextItem[]
  }): Promise<readonly ContextCandidate[]>
}

/** Writer used to persist the exact ranked context for a run. */
export interface GenerationContextWriter {
  selectAndRecordContext(input: GenerationContextSelectionInput): Promise<readonly ContextCandidate[]>
}

/** The durable shape returned by LongformAuthoringService.listContextItems. */
export interface PersistedGenerationContextItem {
  readonly workspaceId: string
  readonly novelId: string
  readonly generationRunId: string
  readonly sourceType: string
  readonly sourceId: string
  readonly rank: number
  readonly excerptHash: string
  readonly tokenCount: number
  readonly selectionReason: string
}

/** Reader used by continuation to recover context after a process restart. */
export interface GenerationContextReader {
  listContextItems(
    workspaceId: string,
    novelId: string,
    generationRunId: string,
  ): Promise<readonly PersistedGenerationContextItem[]>
}

/** Structured data returned by a model adapter. These values remain drafts. */
export interface NovelGenerationAdapterResult {
  readonly records?: readonly Record<string, unknown>[]
  readonly proposals?: readonly Record<string, unknown>[]
}

/** Input given to a structured, provider-specific generation adapter. */
export interface NovelGenerationAdapterInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly generationRunId: string
  readonly instruction: string
  readonly context: readonly ContextCandidate[]
  readonly idempotencyKey: string
}

/** Adapter contract. Implementations must return data, never SQL or DDL. */
export interface NovelGenerationAdapter {
  generate(input: NovelGenerationAdapterInput): Promise<NovelGenerationAdapterResult>
}

/** Durable lookup key for an idempotent generation result. */
export interface GenerationResultLookup {
  readonly workspaceId: string
  readonly novelId: string
  readonly idempotencyKey: string
}

/** Result persisted by the host so retries do not invoke the adapter twice. */
export interface DraftGenerationResult {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly idempotencyKey: string
  readonly selectedContext: readonly ContextCandidate[]
  readonly records: readonly Record<string, unknown>[]
  readonly proposals: readonly Record<string, unknown>[]
}

/** Durable result store. A database-backed implementation can enforce a unique key. */
export interface GenerationResultRepository {
  findByIdempotencyKey(input: GenerationResultLookup): Promise<DraftGenerationResult | undefined>
  save(result: DraftGenerationResult): Promise<void>
  /** Optional durable lock. Implementations should serialize all work for the key. */
  withIdempotencyLock?<T>(input: GenerationResultLookup, callback: () => Promise<T>): Promise<T>
}

export interface LongformGenerationServiceDependencies {
  readonly candidateRepository: PersistedContextCandidateRepository
  readonly contextWriter: GenerationContextWriter | Pick<LongformAuthoringService, 'selectAndRecordContext'>
  readonly contextReader?: GenerationContextReader | Pick<LongformAuthoringService, 'listContextItems'>
  readonly adapter: NovelGenerationAdapter
  readonly resultRepository: GenerationResultRepository
}

export interface DraftGenerationInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly generationRunId: string
  readonly instruction: string
  /** Maximum context items; zero explicitly skips context retrieval and persistence. */
  readonly limit: number
  readonly idempotencyKey: string
}

/** Input for resuming a run from its exact persisted context. */
export interface DraftGenerationContinuationInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly generationRunId: string
  readonly instruction: string
  readonly idempotencyKey: string
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim() === '') throw new Error(`${name} is required`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateDraftTree(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateDraftTree(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, itemValue] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
    if (['sql', 'ddl', 'query', 'databasequery', 'migration', 'migrationfile', 'rawsql'].includes(normalizedKey)) {
      throw new Error(`generation output cannot contain SQL or DDL (${path}.${key})`)
    }
    if (normalizedKey === 'status' && itemValue !== 'draft') {
      throw new Error(`generation output must remain draft-only (${path}.${key})`)
    }
    validateDraftTree(itemValue, `${path}.${key}`)
  }
}

/** Validate provider or enrichment output before it reaches a draft writer. */
export function validateNovelGenerationAdapterResult(value: unknown): NovelGenerationAdapterResult {
  if (!isRecord(value)) throw new Error('generation adapter must return structured output')
  const records = value.records
  const proposals = value.proposals
  if (records !== undefined && !Array.isArray(records)) throw new Error('generation records must be an array')
  if (proposals !== undefined && !Array.isArray(proposals)) throw new Error('generation proposals must be an array')
  if (records === undefined && proposals === undefined) {
    throw new Error('generation adapter output must contain records or proposals')
  }
  const validateItems = (items: readonly unknown[], name: string): readonly Record<string, unknown>[] => {
    return items.map((item) => {
      if (!isRecord(item)) throw new Error(`${name} must contain structured records`)
      validateDraftTree(item, name)
      return item
    })
  }
  return {
    records: validateItems(records ?? [], 'generation records'),
    proposals: validateItems(proposals ?? [], 'generation proposals'),
  }
}

function contextFromPersisted(
  items: readonly PersistedGenerationContextItem[],
  expected: Pick<ContextCandidateQuery, 'workspaceId' | 'novelId'> & { generationRunId: string },
): ContextCandidate[] {
  return items
    .map((item) => {
      if (item.workspaceId !== expected.workspaceId
        || item.novelId !== expected.novelId
        || item.generationRunId !== expected.generationRunId) {
        throw new Error('persisted generation context does not match the requested workspace, novel, or run')
      }
      return item
    })
    .slice()
    .sort((left, right) => left.rank - right.rank)
    .map(item => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      workspaceId: item.workspaceId,
      novelId: item.novelId,
      status: 'draft' as const,
      relevanceScore: 0,
      recencyScore: 0,
      excerptHash: item.excerptHash,
      tokenCount: item.tokenCount,
      selectionReason: item.selectionReason,
    }))
}

async function restorePersistedContext(
  repository: PersistedContextCandidateRepository,
  items: readonly PersistedGenerationContextItem[],
  expected: Pick<ContextCandidateQuery, 'workspaceId' | 'novelId'> & { generationRunId: string },
): Promise<ContextCandidate[]> {
  const base = contextFromPersisted(items, expected)
  if (repository.hydrateContext === undefined) return base
  const hydrated = await repository.hydrateContext({
    workspaceId: expected.workspaceId,
    novelId: expected.novelId,
    items,
  })
  for (const candidate of hydrated) {
    if (candidate.workspaceId !== undefined && candidate.workspaceId !== expected.workspaceId) {
      throw new Error('context candidate workspace mismatch')
    }
    if (candidate.novelId !== undefined && candidate.novelId !== expected.novelId) {
      throw new Error('context candidate novel mismatch')
    }
  }
  const byKey = new Map(hydrated.map(candidate => [`${candidate.sourceType}\u0000${candidate.sourceId}`, candidate]))
  return base.map((candidate) => {
    const hydratedCandidate = byKey.get(`${candidate.sourceType}\u0000${candidate.sourceId}`)
    if (hydratedCandidate === undefined) throw new Error('persisted generation context source is no longer available')
    if (hydratedCandidate.excerptHash !== candidate.excerptHash || hydratedCandidate.tokenCount !== candidate.tokenCount) {
      throw new Error('persisted generation context source has changed since selection')
    }
    return {
      ...hydratedCandidate,
      workspaceId: expected.workspaceId,
      novelId: expected.novelId,
      selectionReason: candidate.selectionReason ?? 'persisted_context',
    }
  })
}

/**
 * Host-side orchestration for long-form draft generation. It has no provider,
 * SQL execution, or publication privileges; all persistence is injected.
 */
export class LongformGenerationService {
  private static readonly sharedInFlight = new Map<string, Promise<DraftGenerationResult>>()
  private static readonly sharedInFlightInputs = new Map<string, Pick<DraftGenerationInput, 'generationRunId'>>()

  constructor(private readonly dependencies: LongformGenerationServiceDependencies) {}

  /** Return the durable result for a retry without invoking the model adapter. */
  async findPersistedResult(input: GenerationResultLookup): Promise<DraftGenerationResult | undefined> {
    return this.dependencies.resultRepository.findByIdempotencyKey(input)
  }

  /** Retrieve, rank, persist, and generate one idempotent draft result. */
  async generate(input: DraftGenerationInput): Promise<DraftGenerationResult> {
    this.validateInput(input)
    return this.runWithIdempotency(input, () => this.generateOnce(input))
  }

  /** Continue a run using only the context already persisted for that run. */
  async continue(input: DraftGenerationContinuationInput): Promise<DraftGenerationResult> {
    this.validateInput(input)
    return this.runWithIdempotency(input, async () => {
      const existing = await this.dependencies.resultRepository.findByIdempotencyKey({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        idempotencyKey: input.idempotencyKey,
      })
      if (existing !== undefined) {
        this.assertResultIdentity(existing, input)
        return existing
      }
      const reader = this.dependencies.contextReader
      if (reader === undefined) throw new Error('context reader is required for continuation')
      const persisted = await reader.listContextItems(input.workspaceId, input.novelId, input.generationRunId)
      if (persisted.length === 0) throw new Error('no persisted context exists for continuation')
      return this.runAdapter(input, await restorePersistedContext(this.dependencies.candidateRepository, persisted, input))
    })
  }

  private async generateOnce(input: DraftGenerationInput): Promise<DraftGenerationResult> {
    const existing = await this.dependencies.resultRepository.findByIdempotencyKey({
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      idempotencyKey: input.idempotencyKey,
    })
    if (existing !== undefined) {
      this.assertResultIdentity(existing, input)
      return existing
    }
    if (input.limit === 0) return this.runAdapter(input, [])
    let selected: readonly ContextCandidate[]
    const persisted = this.dependencies.contextReader === undefined
      ? []
      : await this.dependencies.contextReader.listContextItems(input.workspaceId, input.novelId, input.generationRunId)
    if (persisted.length > 0) {
      // A worker may have persisted context before it was interrupted. Reuse
      // that exact set so a retry cannot silently change the model's inputs.
      selected = await restorePersistedContext(this.dependencies.candidateRepository, persisted, input)
    } else {
      const candidates = await this.dependencies.candidateRepository.findCandidates({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        instruction: input.instruction,
      })
      for (const candidate of candidates) {
        this.validateCandidateScope(candidate, input)
      }
      selected = rankContextCandidates(candidates, input.limit)
      selected = await this.dependencies.contextWriter.selectAndRecordContext({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        generationRunId: input.generationRunId,
        candidates: selected,
        limit: selected.length,
      })
      for (const candidate of selected) this.validateCandidateScope(candidate, input)
      selected = await this.hydrateSelectedContext(input, selected)
    }
    return this.runAdapter(input, selected)
  }

  private async runAdapter(
    input: DraftGenerationInput | DraftGenerationContinuationInput,
    selectedContext: readonly ContextCandidate[],
  ): Promise<DraftGenerationResult> {
    const generated = validateNovelGenerationAdapterResult(await this.dependencies.adapter.generate({
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      generationRunId: input.generationRunId,
      instruction: input.instruction,
      context: selectedContext,
      idempotencyKey: input.idempotencyKey,
    }))
    const result: DraftGenerationResult = {
      generationRunId: input.generationRunId,
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      idempotencyKey: input.idempotencyKey,
      selectedContext: selectedContext.slice(),
      records: generated.records ?? [],
      proposals: generated.proposals ?? [],
    }
    try {
      await this.dependencies.resultRepository.save(result)
      return result
    } catch (error) {
      const winner = await this.dependencies.resultRepository.findByIdempotencyKey({
        workspaceId: result.workspaceId,
        novelId: result.novelId,
        idempotencyKey: result.idempotencyKey,
      })
      if (winner !== undefined) {
        this.assertResultIdentity(winner, result)
        return winner
      }
      throw error
    }
  }

  private async runWithIdempotency(
    input: DraftGenerationInput | DraftGenerationContinuationInput,
    work: () => Promise<DraftGenerationResult>,
  ): Promise<DraftGenerationResult> {
    const lookup = { workspaceId: input.workspaceId, novelId: input.novelId, idempotencyKey: input.idempotencyKey }
    const key = this.key(lookup)
    const running = LongformGenerationService.sharedInFlight.get(key)
    if (running !== undefined) {
      const runningInput = LongformGenerationService.sharedInFlightInputs.get(key)
      if (runningInput !== undefined && runningInput.generationRunId !== input.generationRunId) {
        throw new Error('idempotency key is already bound to another generation run')
      }
      return running.then((result) => {
        this.assertResultIdentity(result, input)
        return result
      })
    }
    LongformGenerationService.sharedInFlightInputs.set(key, { generationRunId: input.generationRunId })
    const durableLock = this.dependencies.resultRepository.withIdempotencyLock
    let task: Promise<DraftGenerationResult>
    try {
      task = durableLock === undefined
        ? work()
        : durableLock.call(this.dependencies.resultRepository, lookup, work) as Promise<DraftGenerationResult>
    } catch (error) {
      LongformGenerationService.sharedInFlightInputs.delete(key)
      throw error
    }
    LongformGenerationService.sharedInFlight.set(key, task)
    try {
      return await task
    } finally {
      LongformGenerationService.sharedInFlight.delete(key)
      LongformGenerationService.sharedInFlightInputs.delete(key)
    }
  }

  private async hydrateSelectedContext(
    input: DraftGenerationInput,
    selected: readonly ContextCandidate[],
  ): Promise<readonly ContextCandidate[]> {
    const hydrateContext = this.dependencies.candidateRepository.hydrateContext
    if (hydrateContext === undefined || selected.length === 0) return selected.slice()
    const items: PersistedGenerationContextItem[] = selected.map((candidate, rank) => ({
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      generationRunId: input.generationRunId,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      rank,
      excerptHash: candidate.excerptHash ?? '',
      tokenCount: candidate.tokenCount ?? 0,
      selectionReason: candidate.selectionReason ?? 'persisted_context',
    }))
    return restorePersistedContext(this.dependencies.candidateRepository, items, input)
  }

  private assertResultIdentity(
    result: DraftGenerationResult,
    input: Pick<DraftGenerationInput | DraftGenerationContinuationInput, 'workspaceId' | 'novelId' | 'generationRunId' | 'idempotencyKey'>,
  ): void {
    if (result.workspaceId !== input.workspaceId || result.novelId !== input.novelId) {
      throw new Error('generation result scope mismatch')
    }
    if (result.idempotencyKey !== input.idempotencyKey) {
      throw new Error('generation result idempotency key mismatch')
    }
    if (result.generationRunId !== input.generationRunId) {
      throw new Error('idempotency key is already bound to another generation run')
    }
  }

  private validateCandidateScope(candidate: ContextCandidate, input: Pick<DraftGenerationInput, 'workspaceId' | 'novelId'>): void {
    if (candidate.workspaceId !== undefined && candidate.workspaceId !== input.workspaceId) {
      throw new Error('context candidate workspace mismatch')
    }
    if (candidate.novelId !== undefined && candidate.novelId !== input.novelId) {
      throw new Error('context candidate novel mismatch')
    }
  }

  private validateInput(input: DraftGenerationInput | DraftGenerationContinuationInput): void {
    assertNonEmpty(input.workspaceId, 'workspaceId')
    assertNonEmpty(input.novelId, 'novelId')
    assertNonEmpty(input.generationRunId, 'generationRunId')
    assertNonEmpty(input.instruction, 'instruction')
    assertNonEmpty(input.idempotencyKey, 'idempotencyKey')
    if ('limit' in input && (!Number.isSafeInteger(input.limit) || input.limit < 0)) {
      throw new Error('context limit must be a non-negative integer')
    }
  }

  private key(input: Pick<DraftGenerationInput, 'workspaceId' | 'novelId' | 'idempotencyKey'>): string {
    return `${input.workspaceId}\u0000${input.novelId}\u0000${input.idempotencyKey}`
  }
}
