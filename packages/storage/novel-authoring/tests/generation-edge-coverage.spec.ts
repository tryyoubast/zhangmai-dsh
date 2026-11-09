import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  LongformGenerationService,
  validateNovelGenerationAdapterResult,
  type DraftGenerationInput,
  type DraftGenerationResult,
  type GenerationResultLookup,
  type LongformGenerationServiceDependencies,
  type NovelGenerationAdapterInput,
  type NovelGenerationAdapterResult,
  type PersistedGenerationContextItem,
} from '../src/generation.ts'
import type { ContextCandidate, GenerationContextSelectionInput } from '../src/index.ts'

function request(): DraftGenerationInput {
  return {
    workspaceId: randomUUID(), novelId: randomUUID(), generationRunId: randomUUID(),
    instruction: 'Write the next draft.', limit: 1, idempotencyKey: randomUUID(),
  }
}

function resultFor(input: DraftGenerationInput): DraftGenerationResult {
  return { ...input, selectedContext: [], records: [{ status: 'draft' }], proposals: [] }
}

function candidate(): ContextCandidate {
  return {
    sourceType: 'chapter_summary', sourceId: 'summary', status: 'published',
    relevanceScore: 1, recencyScore: 1, excerpt: 'Exact selected text', excerptHash: 'digest', tokenCount: 4,
  }
}

function snapshot(input: DraftGenerationInput, overrides: Partial<PersistedGenerationContextItem> = {}): PersistedGenerationContextItem {
  return {
    workspaceId: input.workspaceId, novelId: input.novelId, generationRunId: input.generationRunId,
    sourceType: 'chapter_summary', sourceId: 'saved-summary', rank: 0, excerptHash: 'saved-digest',
    excerpt: 'Saved text', sourceStatus: 'published', tokenCount: 3, selectionReason: 'relevance',
    ...overrides,
  }
}

function fixture(input = request()) {
  const findCandidates = vi.fn<() => Promise<readonly ContextCandidate[]>>().mockResolvedValue([candidate()])
  const selectAndRecordContext = vi.fn<(selection: GenerationContextSelectionInput) => Promise<readonly ContextCandidate[]>>()
    .mockImplementation(async selection => selection.candidates)
  const generate = vi.fn<(input: NovelGenerationAdapterInput) => Promise<NovelGenerationAdapterResult>>()
    .mockResolvedValue({ records: [{ status: 'draft' }] })
  const findByIdempotencyKey = vi.fn<(lookup: GenerationResultLookup) => Promise<DraftGenerationResult | undefined>>()
    .mockResolvedValue(undefined)
  const save = vi.fn<(result: DraftGenerationResult) => Promise<void>>().mockResolvedValue(undefined)
  const dependencies: LongformGenerationServiceDependencies = {
    candidateRepository: { findCandidates }, contextWriter: { selectAndRecordContext },
    adapter: { generate }, resultRepository: { findByIdempotencyKey, save },
  }
  return { input, dependencies, findCandidates, selectAndRecordContext, generate, findByIdempotencyKey, save }
}

describe('untrusted generation data validation', () => {
  it.each([null, [], 'SQL', 42])('rejects a non-object adapter result %j', (value) => {
    expect(() => validateNovelGenerationAdapterResult(value)).toThrow('structured output')
  })

  it.each([
    [{ records: null }, 'records must be an array'],
    [{ proposals: {} }, 'proposals must be an array'],
    [{}, 'must contain records or proposals'],
    [{ records: [null] }, 'structured records'],
    [{ proposals: ['draft'] }, 'structured records'],
  ])('rejects malformed adapter arrays %j', (value, message) => {
    expect(() => validateNovelGenerationAdapterResult(value)).toThrow(message)
  })

  it.each(['sql', 'ddl', 'query', 'database_query', 'migration', 'migration-file', 'raw_sql'])(
    'rejects forbidden %s even inside nested lists', (field) => {
      expect(() => validateNovelGenerationAdapterResult({ records: [{ details: [{ [field]: 'arbitrary text' }] }] }))
        .toThrow('SQL or DDL')
    },
  )

  it('preserves nested draft objects and scalar lists while normalizing an omitted proposals array', () => {
    const records = [{ status: 'draft', details: [{ status: 'draft', labels: ['north', null, 1] }] }]
    expect(validateNovelGenerationAdapterResult({ records })).toEqual({ records, proposals: [] })
    expect(validateNovelGenerationAdapterResult({ proposals: [] })).toEqual({ records: [], proposals: [] })
  })

  it('rejects a nested publication state without treating ordinary scalar fields as statuses', () => {
    expect(() => validateNovelGenerationAdapterResult({ proposals: [{ details: [{ status: 'published' }] }] }))
      .toThrow('draft-only')
  })
})

describe('generation input and persisted-result invariants', () => {
  it.each(['workspaceId', 'novelId', 'generationRunId', 'instruction', 'idempotencyKey'] as const)(
    'rejects blank %s before accessing the repository or model', async (field) => {
      const f = fixture()
      await expect(new LongformGenerationService(f.dependencies).generate({ ...f.input, [field]: ' ' }))
        .rejects.toThrow(`${field} is required`)
      expect(f.findByIdempotencyKey).not.toHaveBeenCalled()
      expect(f.generate).not.toHaveBeenCalled()
    },
  )

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid context limit %s before model execution', async (limit) => {
    const f = fixture()
    await expect(new LongformGenerationService(f.dependencies).generate({ ...f.input, limit })).rejects.toThrow('non-negative integer')
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('returns a persisted lookup without invoking context retrieval or model execution', async () => {
    const f = fixture()
    const persisted = resultFor(f.input)
    f.findByIdempotencyKey.mockResolvedValue(persisted)
    await expect(new LongformGenerationService(f.dependencies).findPersistedResult(f.input)).resolves.toBe(persisted)
    expect(f.generate).not.toHaveBeenCalled()
    expect(f.findCandidates).not.toHaveBeenCalled()
  })

  it.each(['workspaceId', 'novelId', 'idempotencyKey', 'generationRunId'] as const)(
    'rejects a cached result with mismatched %s during generation and continuation', async (field) => {
      const f = fixture()
      f.findByIdempotencyKey.mockResolvedValue({ ...resultFor(f.input), [field]: 'foreign' })
      const service = new LongformGenerationService(f.dependencies)
      await expect(service.generate(f.input)).rejects.toThrow(/scope mismatch|key mismatch|another generation run/)
      await expect(service.continue(f.input)).rejects.toThrow(/scope mismatch|key mismatch|another generation run/)
      expect(f.generate).not.toHaveBeenCalled()
      expect(f.save).not.toHaveBeenCalled()
    },
  )

  it('reuses an identical saved result during continuation without requiring a context reader', async () => {
    const f = fixture()
    const persisted = resultFor(f.input)
    f.findByIdempotencyKey.mockResolvedValue(persisted)
    await expect(new LongformGenerationService(f.dependencies).continue(f.input)).resolves.toBe(persisted)
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('rejects continuation without a snapshot reader', async () => {
    const f = fixture()
    await expect(new LongformGenerationService(f.dependencies).continue(f.input)).rejects.toThrow('context reader is required')
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('rejects continuation when the reader has no saved context', async () => {
    const f = fixture()
    const service = new LongformGenerationService({ ...f.dependencies, contextReader: { async listContextItems() { return [] } } })
    await expect(service.continue(f.input)).rejects.toThrow('no persisted context')
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('uses a matching concurrently saved winner when its own persistence fails', async () => {
    const f = fixture()
    const winner = resultFor(f.input)
    f.save.mockRejectedValue(new Error('unique constraint'))
    f.findByIdempotencyKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner)
    await expect(new LongformGenerationService(f.dependencies).generate(f.input)).resolves.toBe(winner)
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.generate).toHaveBeenCalledOnce()
  })

  it('preserves the original persistence failure when there is no concurrent winner and allows retry', async () => {
    const f = fixture()
    const failure = new Error('write failed')
    f.save.mockRejectedValueOnce(failure)
    const service = new LongformGenerationService(f.dependencies)
    await expect(service.generate(f.input)).rejects.toBe(failure)
    await expect(service.generate(f.input)).resolves.toMatchObject({ generationRunId: f.input.generationRunId })
    expect(f.generate).toHaveBeenCalledTimes(2)
  })

  it('rejects a concurrent winner from another run after a persistence conflict', async () => {
    const f = fixture()
    f.save.mockRejectedValue(new Error('unique constraint'))
    f.findByIdempotencyKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ...resultFor(f.input), generationRunId: 'foreign-run' })
    await expect(new LongformGenerationService(f.dependencies).generate(f.input)).rejects.toThrow('another generation run')
  })
})

describe('generation snapshot restoration and selected-context checks', () => {
  it.each(['workspaceId', 'novelId', 'generationRunId'] as const)(
    'rejects a persisted snapshot belonging to another %s', async (field) => {
      const f = fixture()
      const service = new LongformGenerationService({
        ...f.dependencies,
        contextReader: { async listContextItems() { return [snapshot(f.input, { [field]: 'foreign' })] } },
      })
      await expect(service.continue(f.input)).rejects.toThrow('does not match')
      expect(f.generate).not.toHaveBeenCalled()
    },
  )

  it.each([{ excerpt: null }, { sourceStatus: null }])('requires a rerun for a partial legacy snapshot %j', async (missing) => {
    const f = fixture()
    const service = new LongformGenerationService({
      ...f.dependencies, contextReader: { async listContextItems() { return [snapshot(f.input, missing)] } },
    })
    await expect(service.continue(f.input)).rejects.toMatchObject({ code: 'LEGACY_GENERATION_CONTEXT_REQUIRES_RERUN' })
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('rejects an unknown persisted source status', async () => {
    const f = fixture()
    const service = new LongformGenerationService({
      ...f.dependencies, contextReader: { async listContextItems() { return [snapshot(f.input, { sourceStatus: 'invalid' })] } },
    })
    await expect(service.continue(f.input)).rejects.toThrow('invalid source status')
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('restores historical archived and deleted snapshot statuses in their saved rank order', async () => {
    const f = fixture()
    const service = new LongformGenerationService({
      ...f.dependencies,
      contextReader: {
        async listContextItems() {
          return [snapshot(f.input, { sourceStatus: 'deleted', rank: 1, sourceId: 'second' }),
            snapshot(f.input, { sourceStatus: 'archived', rank: 0, sourceId: 'first' })]
        },
      },
    })
    const result = await service.continue(f.input)
    expect(result.selectedContext.map(item => [item.sourceId, item.status, item.excerpt])).toEqual([
      ['first', 'archived', 'Saved text'], ['second', 'deleted', 'Saved text'],
    ])
    expect(f.findCandidates).not.toHaveBeenCalled()
    expect(f.selectAndRecordContext).not.toHaveBeenCalled()
  })

  it('rejects candidates scoped to another novel before persisting selection', async () => {
    const f = fixture()
    f.findCandidates.mockResolvedValue([{ ...candidate(), novelId: 'foreign' }])
    await expect(new LongformGenerationService(f.dependencies).generate(f.input)).rejects.toThrow('candidate novel mismatch')
    expect(f.selectAndRecordContext).not.toHaveBeenCalled()
    expect(f.generate).not.toHaveBeenCalled()
  })

  it.each(['excerpt', 'excerptHash', 'tokenCount'] as const)(
    'rejects a selected snapshot missing %s before giving context to the model', async (field) => {
      const f = fixture()
      const selected: ContextCandidate = {
        sourceType: 'chapter_summary', sourceId: 'incomplete', status: 'published', relevanceScore: 1, recencyScore: 1,
        ...(field === 'excerpt' ? {} : { excerpt: 'Selected text' }),
        ...(field === 'excerptHash' ? {} : { excerptHash: 'digest' }),
        ...(field === 'tokenCount' ? {} : { tokenCount: 1 }),
      }
      f.selectAndRecordContext.mockResolvedValue([selected])
      await expect(new LongformGenerationService(f.dependencies).generate(f.input)).rejects.toThrow('exact excerpts, hashes, and token counts')
      expect(f.generate).not.toHaveBeenCalled()
      expect(f.save).not.toHaveBeenCalled()
    },
  )
})
