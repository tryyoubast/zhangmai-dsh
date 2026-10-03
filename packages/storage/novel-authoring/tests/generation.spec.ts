import { describe, expect, it, vi } from 'vitest'
import {
  LongformGenerationService,
  type ContextCandidate,
  type DraftGenerationResult,
  type GenerationContextSelectionInput,
  type PersistedGenerationContextItem,
  type PersistedContextCandidateRepository,
  type GenerationResultRepository,
  type NovelGenerationAdapter,
} from '../src/index.ts'

const baseCandidate = (sourceId: string, status: ContextCandidate['status'] = 'published'): ContextCandidate => ({
  sourceType: 'chapter_summary',
  sourceId,
  status,
  relevanceScore: 1,
  recencyScore: 1,
  excerptHash: `${sourceId}-hash`,
  tokenCount: 4,
})

class MemoryResults implements GenerationResultRepository {
  readonly values = new Map<string, DraftGenerationResult>()

  async findByIdempotencyKey(input: {
    workspaceId: string
    novelId: string
    idempotencyKey: string
  }): Promise<DraftGenerationResult | undefined> {
    return this.values.get(`${input.workspaceId}/${input.novelId}/${input.idempotencyKey}`)
  }

  async save(result: DraftGenerationResult): Promise<void> {
    this.values.set(`${result.workspaceId}/${result.novelId}/${result.idempotencyKey}`, result)
  }
}

class MemoryContext implements PersistedContextCandidateRepository {
  candidates: readonly ContextCandidate[] = []
  readonly persisted = new Map<string, PersistedGenerationContextItem[]>()

  async findCandidates(): Promise<readonly ContextCandidate[]> {
    return this.candidates
  }

  async selectAndRecordContext(input: GenerationContextSelectionInput): Promise<readonly ContextCandidate[]> {
    const selected = input.candidates
      .filter(candidate => candidate.status !== 'archived' && candidate.status !== 'deleted')
      .slice(0, input.limit)
    this.persisted.set(input.generationRunId, selected.map((candidate, rank) => ({
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      generationRunId: input.generationRunId,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      rank,
      excerptHash: candidate.excerptHash ?? '',
      tokenCount: candidate.tokenCount ?? 0,
      selectionReason: candidate.selectionReason ?? 'ranked_context',
    })))
    return selected
  }

  async listContextItems(_workspaceId: string, _novelId: string, runId: string): Promise<readonly PersistedGenerationContextItem[]> {
    return this.persisted.get(runId) ?? []
  }
}

const adapter = (calls: { count: number }): NovelGenerationAdapter => ({
  async generate() {
    calls.count += 1
    return { records: [{ kind: 'chapter', status: 'draft' }] }
  },
})

const dependencies = (context: MemoryContext, results: MemoryResults, calls: { count: number }) => ({
  candidateRepository: context,
  contextWriter: context,
  contextReader: context,
  adapter: adapter(calls),
  resultRepository: results,
})

describe('LongformGenerationService', () => {
  it('continues from exact persisted context after a service restart', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('summary-1')]
    const results = new MemoryResults()
    const firstCalls = { count: 0 }
    const first = new LongformGenerationService(dependencies(context, results, firstCalls))
    await first.generate({ workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-1', instruction: 'continue', limit: 1, idempotencyKey: 'key-1' })

    const secondCalls = { count: 0 }
    const restartedContext = new MemoryContext()
    restartedContext.persisted.clear()
    for (const [runId, items] of context.persisted) restartedContext.persisted.set(runId, items)
    const restarted = new LongformGenerationService(dependencies(restartedContext, results, secondCalls))
    const continued = await restarted.generate({ workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-1', instruction: 'continue', limit: 1, idempotencyKey: 'key-2' })
    expect(continued.selectedContext.map(item => item.sourceId)).toEqual(['summary-1'])
    expect(secondCalls.count).toBe(1)
  })

  it('excludes deleted and archived candidates before adapter invocation', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('deleted', 'deleted'), baseCandidate('archived', 'archived'), baseCandidate('live')]
    const calls = { count: 0 }
    const result = await new LongformGenerationService(dependencies(context, new MemoryResults(), calls)).generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-2', instruction: 'write', limit: 5, idempotencyKey: 'key-2',
    })
    expect(result.selectedContext.map(item => item.sourceId)).toEqual(['live'])
    expect(calls.count).toBe(1)
  })

  it('does not duplicate work for a durable idempotency key', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('live')]
    const results = new MemoryResults()
    const calls = { count: 0 }
    const service = new LongformGenerationService(dependencies(context, results, calls))
    const input = { workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-3', instruction: 'write', limit: 1, idempotencyKey: 'same' }
    await service.generate(input)
    await service.generate(input)
    expect(calls.count).toBe(1)
  })

  it('rejects adapter output that is not structured draft data', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('live')]
    const results = new MemoryResults()
    const invalid = { generate: vi.fn(async () => 'not structured') } as unknown as NovelGenerationAdapter
    const service = new LongformGenerationService({ ...dependencies(context, results, { count: 0 }), adapter: invalid })
    await expect(service.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-4', instruction: 'write', limit: 1, idempotencyKey: 'bad',
    })).rejects.toThrow('structured output')
    expect(await results.findByIdempotencyKey({ workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'bad' })).toBeUndefined()
  })

  it('rejects nested publication state and model-supplied SQL', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('live')]
    const nested = {
      generate: vi.fn(async () => ({
        proposals: [{ proposedContent: { status: 'published', database_query: 'DROP TABLE novels' } }],
      })),
    } as unknown as NovelGenerationAdapter
    const service = new LongformGenerationService({ ...dependencies(context, new MemoryResults(), { count: 0 }), adapter: nested })
    await expect(service.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-nested', instruction: 'write', limit: 1, idempotencyKey: 'nested',
    })).rejects.toThrow(/draft-only|SQL or DDL/u)
  })

  it('uses the context set actually returned by the durable writer', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('first'), baseCandidate('second')]
    const writer = {
      async selectAndRecordContext() {
        return [baseCandidate('second')]
      },
    }
    const seen: string[][] = []
    const recordingAdapter: NovelGenerationAdapter = {
      async generate(input) {
        seen.push(input.context.map(candidate => candidate.sourceId))
        return { records: [{ status: 'draft' }] }
      },
    }
    const result = await new LongformGenerationService({
      ...dependencies(context, new MemoryResults(), { count: 0 }),
      contextWriter: writer,
      adapter: recordingAdapter,
    }).generate({ workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-writer', instruction: 'write', limit: 2, idempotencyKey: 'writer' })
    expect(result.selectedContext.map(candidate => candidate.sourceId)).toEqual(['second'])
    expect(seen).toEqual([['second']])
  })

  it('rejects context returned for another workspace', async () => {
    const context = new MemoryContext()
    context.candidates = [{ ...baseCandidate('foreign'), workspaceId: 'w2', novelId: 'n1' }]
    const service = new LongformGenerationService(dependencies(context, new MemoryResults(), { count: 0 }))
    await expect(service.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-foreign', instruction: 'write', limit: 1, idempotencyKey: 'foreign',
    })).rejects.toThrow('context candidate workspace mismatch')
  })

  it('coalesces generate and continue calls for the same idempotency key', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('live')]
    const results = new MemoryResults()
    const calls = { count: 0 }
    const service = new LongformGenerationService(dependencies(context, results, calls))
    const input = { workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-shared', instruction: 'write', limit: 1, idempotencyKey: 'shared' }
    const [first, second] = await Promise.all([service.generate(input), service.continue({
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      generationRunId: input.generationRunId,
      instruction: input.instruction,
      idempotencyKey: input.idempotencyKey,
    })])
    expect(first).toEqual(second)
    expect(calls.count).toBe(1)
  })

  it('rejects a concurrent request that reuses a key for another generation run', async () => {
    const context = new MemoryContext()
    context.candidates = [baseCandidate('live')]
    const results = new MemoryResults()
    let calls = 0
    const adapter: NovelGenerationAdapter = {
      async generate() {
        calls += 1
        await Promise.resolve()
        return { records: [{ status: 'draft' }] }
      },
    }
    const first = new LongformGenerationService({ ...dependencies(context, results, { count: 0 }), adapter })
    const second = new LongformGenerationService({ ...dependencies(context, results, { count: 0 }), adapter })
    const firstRequest = first.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-one', instruction: 'write', limit: 1, idempotencyKey: 'shared-run',
    })
    const secondRequest = second.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-two', instruction: 'write', limit: 1, idempotencyKey: 'shared-run',
    })
    await expect(Promise.all([firstRequest, secondRequest])).rejects.toThrow('idempotency key is already bound to another generation run')
    expect(calls).toBe(1)
  })

  it('hydrates the exact selection returned by the durable context writer', async () => {
    const selected = { ...baseCandidate('persisted'), workspaceId: 'w1', novelId: 'n1', excerptHash: 'persisted-hash', tokenCount: 4 }
    const writer = {
      async selectAndRecordContext() { return [selected] },
    }
    const candidateRepository: PersistedContextCandidateRepository = {
      async findCandidates() { return [] },
      async hydrateContext() {
        return [{ ...selected, excerpt: 'The exact persisted excerpt.' }]
      },
    }
    const seen: string[] = []
    const adapter: NovelGenerationAdapter = {
      async generate(input) {
        seen.push(input.context[0]?.excerpt ?? '')
        return { records: [{ status: 'draft' }] }
      },
    }
    const result = await new LongformGenerationService({
      candidateRepository,
      contextWriter: writer,
      adapter,
      resultRepository: new MemoryResults(),
    }).generate({ workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-hydrate', instruction: 'write', limit: 1, idempotencyKey: 'hydrate' })
    expect(seen).toEqual(['The exact persisted excerpt.'])
    expect(result.selectedContext[0]?.excerpt).toBe('The exact persisted excerpt.')
  })

  it('rejects hydrated context returned from another workspace', async () => {
    const selected = { ...baseCandidate('persisted'), workspaceId: 'w1', novelId: 'n1', excerptHash: 'persisted-hash', tokenCount: 4 }
    const candidateRepository: PersistedContextCandidateRepository = {
      async findCandidates() { return [] },
      async hydrateContext() { return [{ ...selected, workspaceId: 'w2', excerpt: 'foreign' }] },
    }
    const service = new LongformGenerationService({
      candidateRepository,
      contextWriter: { async selectAndRecordContext() { return [selected] } },
      adapter: adapter({ count: 0 }),
      resultRepository: new MemoryResults(),
    })
    await expect(service.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-hydrate-foreign', instruction: 'write', limit: 1, idempotencyKey: 'hydrate-foreign',
    })).rejects.toThrow('context candidate workspace mismatch')
  })

  it('treats a zero context limit as an explicit no-context generation', async () => {
    const findCandidates = vi.fn(async () => { throw new Error('context query should not run for limit zero') })
    const selectAndRecordContext = vi.fn(async () => { throw new Error('context writer should not run for limit zero') })
    const service = new LongformGenerationService({
      candidateRepository: { findCandidates },
      contextWriter: { selectAndRecordContext },
      adapter: adapter({ count: 0 }),
      resultRepository: new MemoryResults(),
    })
    const result = await service.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-no-context', instruction: 'write', limit: 0, idempotencyKey: 'no-context',
    })
    expect(result.selectedContext).toEqual([])
    expect(findCandidates).not.toHaveBeenCalled()
    expect(selectAndRecordContext).not.toHaveBeenCalled()
  })

  it('rejects an idempotency result bound to another generation run', async () => {
    const context = new MemoryContext()
    const results = new MemoryResults()
    await results.save({
      generationRunId: 'run-existing', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'reused', selectedContext: [], records: [], proposals: [],
    })
    const service = new LongformGenerationService(dependencies(context, results, { count: 0 }))
    await expect(service.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-requested', instruction: 'write', limit: 1, idempotencyKey: 'reused',
    })).rejects.toThrow('idempotency key is already bound to another generation run')
  })
})
