import { describe, expect, it, vi } from 'vitest'
import {
  NovelAuthoringService, WorkspaceAuthoringService, ProposalReviewService, ProposalPublicationService,
  LongformAuthoringService, assertOptimisticVersion, rankContextCandidates, validateChapterContentStorage,
  type ContextCandidate, type GenerationRunInput,
} from '../src/index.ts'
import { editor, owner, worker, serviceDatabase, type Row } from './coverage-fixture.ts'

const base = { workspaceId: 'workspace', novelId: 'novel', generationRunId: 'run', idempotencyKey: 'retry' }
const named = { ...base, name: 'Mira' }

describe('fixed draft persistence outcomes', () => {
  it('rejects a malformed chapter summary digest before persistence', async () => {
    const db = serviceDatabase()
    await expect(new NovelAuthoringService(db.database, worker).createChapterSummaryDraft({ ...base,
      chapterId: 'chapter', chapterVersionId: 'version', summaryKind: 'short', contentText: 'Text', contentSha256: 'invalid',
    })).rejects.toThrow('summary SHA-256')
    expect(db.transactions).toBe(0)
  })
  const methods = [
    { name: 'character', call: (service: NovelAuthoringService) => service.createCharacterDraft(named) },
    { name: 'skill', call: (service: NovelAuthoringService) => service.createSkillDraft(named) },
    { name: 'location', call: (service: NovelAuthoringService) => service.createLocationDraft({ ...named, attributes: { climate: 'dry' } }) },
    { name: 'faction', call: (service: NovelAuthoringService) => service.createFactionDraft(named) },
    { name: 'item', call: (service: NovelAuthoringService) => service.createItemDraft(named) },
    { name: 'storyline', call: (service: NovelAuthoringService) => service.createStorylineDraft(named) },
    { name: 'outline', call: (service: NovelAuthoringService) => service.createOutlineDraft(named) },
    { name: 'entity relation', call: (service: NovelAuthoringService) => service.createEntityRelationDraft({ ...base, sourceEntityType: 'characters', sourceEntityId: 'c', targetEntityType: 'locations', targetEntityId: 'l', relationType: 'lives' }) },
    { name: 'character skill', call: (service: NovelAuthoringService) => service.createCharacterSkillDraft({ ...base, characterId: 'c', skillId: 's', relationType: 'learned' }) },
    { name: 'story fact', call: (service: NovelAuthoringService) => service.createStoryFactDraft({ ...base, factKey: 'weather', statement: 'Dry' }) },
    { name: 'timeline', call: (service: NovelAuthoringService) => service.createTimelineEventDraft({ ...base, eventKey: 'arrival', title: 'Arrival' }) },
    { name: 'summary', call: (service: NovelAuthoringService) => service.createChapterSummaryDraft({ ...base, chapterId: 'c', chapterVersionId: 'v', summaryKind: 'short', contentText: 'Arrival', contentSha256: 'a'.repeat(64) }) },
    { name: 'proposal', call: (service: NovelAuthoringService) => service.createDraftProposal({ ...base, targetType: 'characters', operation: 'update', baseVersionNo: 1, proposedContent: { name: 'Mira' }, validationResult: {} }) },
  ]
  it.each(methods)('persists $name as a draft and accepts only an identical retry', async ({ call }) => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, worker)
    await expect(call(service)).resolves.toBe('created')
    const values = db.writes[0]?.values as Row
    expect(values.status).toBe('draft')
    expect(values.workspaceId).toBe('workspace')
    db.inserts.push([])
    db.selects.push([{ ...values, id: 'existing' }])
    await expect(call(service)).resolves.toBe('existing')
    db.inserts.push([])
    db.selects.push([{ ...values, id: 'existing', novelId: 'another-novel' }])
    await expect(call(service)).rejects.toThrow('idempotency conflict')
    expect(db.rollbacks).toBe(1)
  })
  it.each([undefined, 0])('rejects proposal update without a positive base version %s', async (version) => {
    const db = serviceDatabase()
    await expect(new NovelAuthoringService(db.database, worker).createDraftProposal({ ...base, targetType: 'characters', operation: 'update', ...(version === undefined ? {} : { baseVersionNo: version }), proposedContent: {}, validationResult: {} })).rejects.toThrow('positive base version')
    expect(db.transactions).toBe(0)
  })
  it.each(['missing', 'without ID'] as const)('rejects an idempotency conflict row that is %s', async (state) => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, worker)
    await service.createCharacterDraft(named)
    db.inserts.push([])
    db.selects.push(state === 'missing' ? [] : [{ ...db.writes[0]?.values as Row }])
    await expect(service.createCharacterDraft(named)).rejects.toThrow(state === 'missing' ? 'not found' : 'no ID')
  })
  it.each(methods)('rejects $name before the database when worker workspace differs', async ({ call }) => {
    const db = serviceDatabase()
    await expect(call(new NovelAuthoringService(db.database, { ...worker, workspaceId: 'other' }))).rejects.toThrow('workspace context mismatch')
    expect(db.transactions).toBe(0)
  })
})

describe('generation lifecycle persistence', () => {
  const input: GenerationRunInput = { ...base, model: 'configured', promptVersion: 'v1', sourceSessionId: 'session', instruction: '  Write  ', contextLimit: 0 }
  it('trims durable instructions and preserves explicit zero limits for human requests and retries', async () => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, editor)
    await service.createGenerationRun(input)
    const values = db.writes[0]?.values as Row
    expect(values).toMatchObject({ instruction: 'Write', contextLimit: 0, agentPrincipalId: 'user-request' })
    db.inserts.push([])
    db.selects.push([{ ...values, id: 'saved-run' }])
    await expect(service.createGenerationRun(input)).resolves.toBe('saved-run')
  })
  it.each([{ instruction: ' ' }, { contextLimit: -1 }, { contextLimit: 129 }, { contextLimit: 1.5 }, { workspaceId: 'elsewhere' }])('rejects invalid generation input %j before persistence', async (override) => {
    const db = serviceDatabase()
    await expect(new NovelAuthoringService(db.database, worker).createGenerationRun({ ...input, ...override })).rejects.toThrow()
    expect(db.transactions).toBe(0)
  })
  it.each([null, 'source'] as const)('claims a durable request with source session %s', async (sourceSessionId) => {
    const db = serviceDatabase()
    db.selects.push([{ novelId: 'novel' }], [{ ...input, id: 'run', sourceSessionId, instruction: 'Write' }])
    db.executionReplies.set(5, [{ claimed: true }])
    const result = await new NovelAuthoringService(db.database, worker).getQueuedGenerationRequest(base)
    expect(result.sourceSessionId).toBe(sourceSessionId ?? '00000000-0000-0000-0000-000000000000')
    expect(result.generationRunId).toBe('run')
  })
  it.each(['missing', 'unclaimed', 'disappeared', 'empty'] as const)('rejects %s queued requests', async (state) => {
    const db = serviceDatabase()
    db.selects.push(state === 'missing' ? [] : [{ novelId: 'novel' }])
    db.executionReplies.set(5, state === 'unclaimed' ? [] : [{ claimed: true }])
    db.selects.push(state === 'disappeared' ? [] : [{ ...input, instruction: ' ' }])
    await expect(new NovelAuthoringService(db.database, worker).getQueuedGenerationRequest(base)).rejects.toThrow()
    expect(db.rollbacks).toBe(1)
  })
  it('reads statuses without mutating the run and rejects a missing run', async () => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, editor)
    db.selects.push([{ status: 'running' }], [])
    await expect(service.getGenerationRunStatus(base)).resolves.toBe('running')
    await expect(service.getGenerationRunStatus(base)).rejects.toThrow('not found')
    expect(db.writes).toHaveLength(0)
  })
  it.each(['running', 'completed', 'failed', 'cancelled'] as const)('records %s timestamps and diagnostic fields', async (status) => {
    const db = serviceDatabase()
    db.selects.push([{ status: 'running' }])
    const now = new Date('2026-11-09T00:00:00Z')
    await new NovelAuthoringService(db.database, worker).updateGenerationRunStatus({ ...base, status, heartbeatAt: now, completedAt: now, errorCode: 'provider', errorSummary: 'safe summary' })
    expect(db.writes[0]?.values).toMatchObject({ status, completedAt: status === 'running' ? null : now, heartbeatAt: status === 'running' ? now : undefined, errorCode: 'provider', errorSummary: 'safe summary' })
  })
  it('uses current time for a default heartbeat and terminal completion', async () => {
    const db = serviceDatabase()
    db.selects.push([{ status: 'queued' }], [{ status: 'running' }])
    const service = new NovelAuthoringService(db.database, worker)
    await service.updateGenerationRunStatus({ ...base, status: 'running' })
    await service.updateGenerationRunStatus({ ...base, status: 'completed' })
    expect((db.writes[0]?.values as Row).heartbeatAt).toBeInstanceOf(Date)
    expect((db.writes[1]?.values as Row).completedAt).toBeInstanceOf(Date)
  })
  it.each(['missing', 'diagnostic'] as const)('rejects %s lifecycle update without a write', async (state) => {
    const db = serviceDatabase()
    db.selects.push(state === 'missing' ? [] : [{ status: 'running' }])
    await expect(new NovelAuthoringService(db.database, worker).updateGenerationRunStatus({ ...base, status: 'failed', errorSummary: 'x'.repeat(513) })).rejects.toThrow()
    expect(db.writes).toHaveLength(0)
  })
  it('rejects workspace mismatches for each lifecycle operation before persistence', async () => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, worker)
    const invalid = { ...base, workspaceId: 'other' }
    await expect(service.getQueuedGenerationRequest(invalid)).rejects.toThrow('context mismatch')
    await expect(service.getGenerationRunStatus(invalid)).rejects.toThrow('context mismatch')
    await expect(service.updateGenerationRunStatus({ ...invalid, status: 'running' })).rejects.toThrow('context mismatch')
    expect(db.transactions).toBe(0)
  })
})

describe('workspace management and publication authorization', () => {
  it('creates trimmed workspace and owner membership in one transaction', async () => {
    const db = serviceDatabase()
    await expect(new WorkspaceAuthoringService(db.database, owner).createWorkspace({ name: '  Research  ' })).resolves.toBe('created')
    expect(db.writes.map(write => write.values)).toEqual([{ ownerUserId: 'user', name: 'Research', status: 'active' }, { workspaceId: 'created', userId: 'user', role: 'owner' }])
    expect(db.transactions).toBe(1)
  })
  it('returns visible workspace and member rows', async () => {
    const db = serviceDatabase()
    db.selects.push([{ id: 'w' }], [{ userId: 'member' }])
    const service = new WorkspaceAuthoringService(db.database, owner)
    await expect(service.listWorkspaces()).resolves.toEqual([{ id: 'w' }])
    await expect(service.listMembers('workspace')).resolves.toEqual([{ userId: 'member' }])
  })
  it('rejects blank and absent-created workspaces', async () => {
    const db = serviceDatabase()
    const service = new WorkspaceAuthoringService(db.database, owner)
    await expect(service.createWorkspace({ name: ' ' })).rejects.toThrow('name is required')
    db.inserts.push([])
    await expect(service.createWorkspace({ name: 'Valid' })).rejects.toThrow('was not created')
    expect(db.writes).toHaveLength(1)
  })
  it.each([undefined, { genre: 'fantasy' }])('creates a draft novel preserving attributes %j', async (attributes) => {
    const db = serviceDatabase()
    await expect(new WorkspaceAuthoringService(db.database, owner).createNovel({ workspaceId: 'workspace', title: '  Book  ', ...(attributes === undefined ? {} : { attributes }) })).resolves.toBe('created')
    expect(db.writes[0]?.values).toMatchObject({ title: 'Book', status: 'draft', attributesJsonb: attributes ?? {} })
  })
  it('rejects absent-created or blank novels', async () => {
    const db = serviceDatabase()
    const service = new WorkspaceAuthoringService(db.database, owner)
    await expect(service.createNovel({ workspaceId: 'workspace', title: ' ' })).rejects.toThrow('title is required')
    db.inserts.push([])
    await expect(service.createNovel({ workspaceId: 'workspace', title: 'Book' })).rejects.toThrow('was not created')
  })
  const operations = [
    { name: 'create novel', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.createNovel({ workspaceId, title: 'Book' }) },
    { name: 'change role', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.changeMemberRole(workspaceId, 'member', 'admin') },
    { name: 'invite', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.inviteMember(workspaceId, 'member', 'member') },
    { name: 'revoke', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.revokeMember(workspaceId, 'member') },
    { name: 'list members', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.listMembers(workspaceId) },
    { name: 'transfer', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.transferOwnership(workspaceId, 'successor') },
    { name: 'archive', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.archiveWorkspace(workspaceId) },
    { name: 'restore', call: (service: WorkspaceAuthoringService, workspaceId: string) => service.restoreWorkspace(workspaceId) },
  ]
  it.each(operations)('performs authorized $name and rejects other workspaces or insufficient roles', async ({ call }) => {
    const db = serviceDatabase()
    await call(new WorkspaceAuthoringService(db.database, owner), 'workspace')
    await expect(call(new WorkspaceAuthoringService(db.database, owner), 'other')).rejects.toThrow('context mismatch')
    await expect(call(new WorkspaceAuthoringService(db.database, { ...editor, roles: [] }), 'workspace')).rejects.toThrow(/permission|membership/)
  })
  it('prevents agents managing workspaces', async () => {
    await expect(new WorkspaceAuthoringService(serviceDatabase().database, worker).createWorkspace({ name: 'Book' })).rejects.toThrow('only users')
  })
  it('calls publication procedures only for human owners and positive rollback versions', async () => {
    const db = serviceDatabase()
    const service = new ProposalPublicationService(db.database, owner)
    await service.publish({ workspaceId: 'workspace', proposalId: 'proposal' })
    await service.rollback({ workspaceId: 'workspace', targetType: 'characters', targetId: 'c', versionNo: 1 })
    expect(db.transactions).toBe(2)
    expect(db.executes).toHaveLength(10)
    for (const principal of [worker, editor, { ...owner, workspaceId: 'other' }]) {
      await expect(new ProposalPublicationService(db.database, principal).publish({ workspaceId: 'workspace', proposalId: 'p' })).rejects.toThrow()
    }
    for (const versionNo of [0, 1.5]) await expect(service.rollback({ workspaceId: 'workspace', targetType: 'characters', targetId: 'c', versionNo })).rejects.toThrow('positive')
  })
})

describe('proposal review writes', () => {
  it.each(['approved', 'rejected', 'expired', 'draft'] as const)('updates reviewer fields for %s', async (decision) => {
    const db = serviceDatabase()
    db.selects.push([{ status: decision === 'draft' ? 'rejected' : 'draft', targetId: decision === 'draft' ? null : 'target' }])
    await new ProposalReviewService(db.database, owner).review({ workspaceId: 'workspace', proposalId: 'proposal', decision })
    const values = db.writes[0]?.values as Row
    expect(values.status).toBe(decision)
    expect(values.reviewedByUserId).toBe(decision === 'draft' ? null : 'user')
    expect(values.reviewedAt === null).toBe(decision === 'draft')
    expect(values.publishedAt).toBeNull()
  })
  it.each(['missing', 'unbound'] as const)('rejects %s review without changing state', async (state) => {
    const db = serviceDatabase()
    db.selects.push(state === 'missing' ? [] : [{ status: 'draft', targetId: null }])
    await expect(new ProposalReviewService(db.database, owner).review({ workspaceId: 'workspace', proposalId: 'p', decision: 'approved' })).rejects.toThrow()
    expect(db.writes).toHaveLength(0)
  })
  it('enforces reviewer identity, scope, and permission before lookup', async () => {
    for (const principal of [worker, { ...owner, workspaceId: 'other' }, editor, { ...editor, roles: [] }]) {
      const db = serviceDatabase()
      const service = new ProposalReviewService(db.database, principal)
      await expect(service.review({ workspaceId: 'workspace', proposalId: 'p', decision: principal.roles.length === 0 ? 'rejected' : 'approved' })).rejects.toThrow()
      expect(db.transactions).toBe(0)
    }
  })
})

describe('chapter storage and ranking edge behavior', () => {
  it.each([NaN, 0, -1, 1.5])('rejects invalid optimistic version %s', (value) => {
    expect(() => { assertOptimisticVersion(value, 1) }).toThrow('version conflict')
    expect(() => { assertOptimisticVersion(1, value) }).toThrow('version conflict')
  })
  it('retains stable order for ranking ties and excludes archived/deleted sources', () => {
    const item = (id: string, score = 0, status: ContextCandidate['status'] = 'draft'): ContextCandidate => ({ sourceType: 'character', sourceId: id, status, relevanceScore: 0, recencyScore: score })
    expect(rankContextCandidates([item('first'), item('recent', 1), item('tie'), item('archive', 1, 'archived'), item('deleted', 1, 'deleted')], 5).map(value => value.sourceId)).toEqual(['recent', 'first', 'tie'])
    expect(() => rankContextCandidates([], -1)).toThrow('context limit')
    expect(() => rankContextCandidates([], 0.5)).toThrow('context limit')
  })
  it('rejects all inconsistent inline and object metadata', () => {
    const inline = { contentSha256: 'a'.repeat(64), contentBytes: 1, contentStorageKind: 'postgres_text' as const, contentText: 'a' }
    const { contentText: _contentText, ...withoutText } = inline
    const invalid = [
      { ...inline, contentBytes: -1 }, { ...inline, contentBytes: 1.5 },
      withoutText, { ...inline, contentObjectKey: 'object' }, { ...inline, contentBytes: 2 },
      { ...withoutText, contentStorageKind: 'object_storage' as const },
      { ...withoutText, contentStorageKind: 'object_storage' as const, contentObjectKey: ' ' },
      { ...inline, contentStorageKind: 'object_storage' as const, contentObjectKey: 'object' },
      { ...withoutText, contentStorageKind: 'object_storage' as const, contentObjectKey: 'object' },
    ]
    for (const value of invalid) expect(() => { validateChapterContentStorage(value) }).toThrow()
  })
  it('checks object provider readiness before persisting a large version', async () => {
    const db = serviceDatabase()
    const assertAvailable = vi.fn(async () => undefined)
    const service = new LongformAuthoringService(db.database, worker, { assertAvailable })
    await service.createChapterVersionDraft({ ...base, chapterId: 'chapter', versionNo: 1, contentSha256: 'a'.repeat(64), contentBytes: 1024 * 1024 + 1, contentStorageKind: 'object_storage', contentObjectKey: 'object' })
    expect(assertAvailable).toHaveBeenCalledOnce()
    expect(db.writes[0]?.values).toMatchObject({ contentObjectKey: 'object', sourceType: 'ai_generation' })
    assertAvailable.mockRejectedValueOnce(new Error('provider down'))
    await expect(service.createChapterVersionDraft({ ...base, chapterId: 'chapter', versionNo: 1, contentSha256: 'a'.repeat(64), contentBytes: 1024 * 1024 + 1, contentStorageKind: 'object_storage', contentObjectKey: 'object' })).rejects.toThrow('provider down')
    expect(db.writes).toHaveLength(1)
  })
})
