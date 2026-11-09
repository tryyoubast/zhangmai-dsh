import { describe, expect, it, vi } from 'vitest'
import { createDatabase } from '@deepseek-ai/dsh-database-postgres'
import {
  LongformAuthoringService, PostgresGenerationResultRepository, PostgresNovelContextRepository, ProposalReviewService,
  type ContextCandidate, type DraftGenerationResult, type GenerationContextItemInput,
} from '../src/index.ts'
import { editor, worker, serviceDatabase, type Row } from './coverage-fixture.ts'

const base = { workspaceId: 'workspace', novelId: 'novel', generationRunId: 'run', idempotencyKey: 'retry' }
const snapshot: GenerationContextItemInput = { ...base, sourceType: 'character', sourceId: 'character', rank: 0, excerpt: 'A courier', excerptHash: 'digest', sourceStatus: 'draft', tokenCount: 3, selectionReason: 'ranked' }
const candidate: ContextCandidate = { sourceType: 'character', sourceId: 'character', status: 'draft', relevanceScore: 1, recencyScore: 1, excerpt: 'A courier', excerptHash: 'digest', tokenCount: 3 }

describe('longform draft and snapshot persistence', () => {
  it.each(['chapter', 'chapter version'] as const)('persists a %s and reuses only an identical draft', async (kind) => {
    const db = serviceDatabase()
    const service = new LongformAuthoringService(db.database, worker)
    const write = kind === 'chapter'
      ? () => service.createChapterDraft({ ...base, chapterNo: 1, title: 'Arrival' })
      : () => service.createChapterVersionDraft({ ...base, chapterId: 'chapter', versionNo: 1, contentStorageKind: 'postgres_text', contentText: 'hello', contentSha256: 'a'.repeat(64), contentBytes: 5 })
    await expect(write()).resolves.toBe('created')
    const values = db.writes[0]?.values as Row
    expect(values.status).toBe('draft')
    db.inserts.push([])
    db.selects.push([{ ...values, id: 'existing' }])
    await expect(write()).resolves.toBe('existing')
    db.inserts.push([])
    db.selects.push([{ ...values, novelId: 'other', id: 'existing' }])
    await expect(write()).rejects.toThrow('idempotency conflict')
  })
  it('rejects chapter and context requests outside the worker workspace', async () => {
    const db = serviceDatabase()
    const service = new LongformAuthoringService(db.database, worker)
    await expect(service.createChapterDraft({ ...base, workspaceId: 'other', chapterNo: 1, title: 'Arrival' })).rejects.toThrow('context mismatch')
    await expect(service.selectAndRecordContext({ ...base, workspaceId: 'other', candidates: [], limit: 0 })).rejects.toThrow('context mismatch')
    await expect(service.listContextItems('other', 'novel', 'run')).rejects.toThrow('context mismatch')
    expect(db.transactions).toBe(0)
  })
  it.each([{ excerpt: '' }, { workspaceId: 'other' }])('rejects invalid snapshot input %j before persistence', async (override) => {
    const db = serviceDatabase()
    await expect(new LongformAuthoringService(db.database, worker).recordContextItems([{ ...snapshot, ...override }])).rejects.toThrow()
    expect(db.transactions).toBe(0)
  })
  it.each(['draft', 'published', 'archived', 'deleted'] as const)('replays saved %s snapshots without inserting current candidates', async (sourceStatus) => {
    const db = serviceDatabase()
    db.selects.push([{ ...snapshot, sourceStatus }])
    const result = await new LongformAuthoringService(db.database, worker).selectAndRecordContext({ ...base, candidates: [], limit: 0 })
    expect(result).toEqual([expect.objectContaining({ status: sourceStatus, excerpt: 'A courier', selectionReason: 'ranked' })])
    expect(db.writes).toHaveLength(0)
  })
  it.each([{ excerpt: null }, { sourceStatus: null }, { sourceStatus: 'invalid' }])('rejects unusable persisted snapshots %j', async (override) => {
    const db = serviceDatabase()
    db.selects.push([{ ...snapshot, ...override }])
    await expect(new LongformAuthoringService(db.database, worker).selectAndRecordContext({ ...base, candidates: [], limit: 0 })).rejects.toThrow('snapshot')
    expect(db.rollbacks).toBe(1)
  })
  it.each(['excerpt', 'excerptHash', 'tokenCount'] as const)('requires %s on newly selected candidates', async (field) => {
    const db = serviceDatabase()
    db.selects.push([])
    await expect(new LongformAuthoringService(db.database, worker).selectAndRecordContext({ ...base, candidates: [{ ...candidate, [field]: undefined }], limit: 1 })).rejects.toThrow('exact excerpts')
    expect(db.writes).toHaveLength(0)
  })
  it.each([undefined, 'explicit'] as const)('persists selected snapshots with selection reason %s then returns database rows', async (selectionReason) => {
    const db = serviceDatabase()
    db.selects.push([], [{ ...snapshot, selectionReason: selectionReason ?? 'ranked_context' }])
    const result = await new LongformAuthoringService(db.database, worker).selectAndRecordContext({
      ...base, candidates: [{ ...candidate, ...(selectionReason === undefined ? {} : { selectionReason }) }], limit: 1,
    })
    expect(db.writes[0]?.values).toEqual([expect.objectContaining({ excerpt: 'A courier', rank: 0, selectionReason: selectionReason ?? 'ranked_context' })])
    expect(result[0]?.selectionReason).toBe(selectionReason ?? 'ranked_context')
  })
  it('returns an empty selection without inserting and lists stored context rows', async () => {
    const db = serviceDatabase()
    db.selects.push([], [], [{ ...snapshot }])
    const service = new LongformAuthoringService(db.database, worker)
    await expect(service.selectAndRecordContext({ ...base, candidates: [], limit: 0 })).resolves.toEqual([])
    await expect(service.listContextItems('workspace', 'novel', 'run')).resolves.toEqual([snapshot])
    expect(db.writes).toHaveLength(0)
  })
  it('binds only existing unbound draft proposals', async () => {
    const db = serviceDatabase()
    const review = new ProposalReviewService(db.database, editor)
    db.selects.push([{ status: 'draft', targetId: null }])
    await review.bindTarget({ workspaceId: 'workspace', proposalId: 'proposal', targetId: 'character' })
    expect(db.writes[0]?.values).toEqual({ targetId: 'character' })
    for (const existing of [[], [{ status: 'approved', targetId: null }], [{ status: 'draft', targetId: 'bound' }]]) {
      db.selects.push(existing)
      await expect(review.bindTarget({ workspaceId: 'workspace', proposalId: 'proposal', targetId: 'character' })).rejects.toThrow()
    }
    for (const principal of [worker, { ...editor, workspaceId: 'other' }, { ...editor, roles: [] }]) {
      await expect(new ProposalReviewService(db.database, principal).bindTarget({ workspaceId: 'workspace', proposalId: 'proposal', targetId: 'character' })).rejects.toThrow()
    }
  })
})

describe('context retrieval adapter metadata and scope', () => {
  it.each(['published', 'draft'])('maps %s result metadata and bounds UTF-8 excerpts', async (status) => {
    const db = serviceDatabase()
    db.executionReplies.set(5, [{ source_type: 'character', source_id: 'character', status, updated_at: new Date(1234), relevance_score: 0.5, excerpt: 'a'.repeat(20_000) }])
    const result = await new PostgresNovelContextRepository(db.database, worker).findCandidates({ ...base, instruction: 'courier' })
    expect(result).toEqual([expect.objectContaining({ workspaceId: 'workspace', novelId: 'novel', status, recencyScore: 1234, tokenCount: 4096, excerpt: 'a'.repeat(16_384) })])
    expect(result[0]?.excerptHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('uses at least one estimated token for empty hydrated excerpts and avoids queries for empty requests', async () => {
    const db = serviceDatabase()
    const repository = new PostgresNovelContextRepository(db.database, editor)
    await expect(repository.hydrateContext({ ...base, items: [] })).resolves.toEqual([])
    expect(db.transactions).toBe(0)
    db.executionReplies.set(5, [{ source_type: 'character', source_id: 'character', status: 'draft', updated_at: new Date(0), relevance_score: 0, excerpt: '' }])
    const result = await repository.hydrateContext({ ...base, items: [snapshot] })
    expect(result[0]?.tokenCount).toBe(1)
  })
  it('rejects missing agent identity and blank novel/workspace before reading', async () => {
    const { agentPrincipalId: _agentPrincipalId, ...withoutAgent } = worker
    for (const [principal, query] of [
      [withoutAgent, base], [worker, { ...base, novelId: ' ' }], [{ ...editor, workspaceId: '' }, { ...base, workspaceId: '' }],
      [worker, { ...base, workspaceId: 'other' }],
    ] as const) {
      const db = serviceDatabase()
      await expect(new PostgresNovelContextRepository(db.database, principal).findCandidates({ ...query, instruction: 'Write' })).rejects.toThrow()
      expect(db.transactions).toBe(0)
    }
  })
})

describe('generation result persistence scope', () => {
  const saved: DraftGenerationResult = { ...base, selectedContext: [], records: [{ status: 'draft' }], proposals: [] }
  it('reads and writes saved output inside request context and supports adapters without a connection pool', async () => {
    const db = serviceDatabase()
    const repository = new PostgresGenerationResultRepository(db.database, worker)
    db.selects.push([], [{ ...saved }])
    await expect(repository.findByIdempotencyKey(base)).resolves.toBeUndefined()
    await repository.save(saved)
    expect(db.writes[0]?.values).toEqual(saved)
    await expect(repository.withIdempotencyLock(base, () => repository.findByIdempotencyKey(base))).resolves.toEqual(saved)
    expect(db.transactions).toBe(3)
  })
  it('rejects foreign scope, blank identity and non-agent result access before any SQL', async () => {
    const withoutAgent = { userId: worker.userId, sessionId: worker.sessionId, workspaceId: worker.workspaceId, clientType: worker.clientType, roles: worker.roles, actorType: 'agent' as const }
    for (const [principal, input] of [
      [editor, base], [withoutAgent, base], [worker, { ...base, workspaceId: 'foreign' }], [worker, { ...base, novelId: '' }], [{ ...worker, workspaceId: '' }, { ...base, workspaceId: '' }],
    ] as const) {
      const db = serviceDatabase()
      const repository = new PostgresGenerationResultRepository(db.database, principal)
      await expect(repository.findByIdempotencyKey(input)).rejects.toThrow()
      await expect(repository.save({ ...saved, ...input })).rejects.toThrow()
      await expect(repository.withIdempotencyLock(input, vi.fn())).rejects.toThrow()
      expect(db.transactions).toBe(0)
    }
  })
  it('keeps reads and writes on the connection holding the durable lock', async () => {
    const database = createDatabase({
      url: 'postgresql://unused:unused@127.0.0.1:5432/unused', maxConnections: 1,
      idleTimeoutMs: 1000, connectionTimeoutMs: 1000, applicationName: 'result-lock-test', runtimeRole: 'dsh_worker_runtime',
    })
    const query = vi.fn(async () => ({ rows: [] }))
    const release = vi.fn()
    const connect = vi.spyOn(database.pool, 'connect').mockImplementation(async () => ({ query, release }))
    try {
      const repository = new PostgresGenerationResultRepository(database, worker)
      await repository.withIdempotencyLock(base, async () => {
        await expect(repository.findByIdempotencyKey(base)).resolves.toBeUndefined()
        await repository.save(saved)
      })
      expect(connect).toHaveBeenCalledOnce()
      expect(query).toHaveBeenCalledTimes(9)
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await database.close()
    }
  })
  it('preserves the original callback error and releases the client if rollback fails', async () => {
    const database = createDatabase({
      url: 'postgresql://unused:unused@127.0.0.1:5432/unused', maxConnections: 1,
      idleTimeoutMs: 1000, connectionTimeoutMs: 1000, applicationName: 'result-rollback-test', runtimeRole: 'dsh_worker_runtime',
    })
    const query = vi.fn(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('rollback unavailable')
      return { rows: [] }
    })
    const release = vi.fn()
    vi.spyOn(database.pool, 'connect').mockImplementation(async () => ({ query, release }))
    const failure = new Error('original failure')
    try {
      const repository = new PostgresGenerationResultRepository(database, worker)
      await expect(repository.withIdempotencyLock(base, async () => { throw failure })).rejects.toBe(failure)
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await database.close()
    }
  })
})
