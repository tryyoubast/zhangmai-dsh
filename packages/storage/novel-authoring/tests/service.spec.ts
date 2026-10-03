import { describe, expect, it } from 'vitest'
import {
  assertDraftAuthor,
  assertGenerationWorker,
  assertGenerationRunTransition,
  assertProposalReviewTransition,
  LongformAuthoringService,
  NovelAuthoringService,
  ProposalPublicationService,
  assertOptimisticVersion,
  rankContextCandidates,
  validateChapterContentStorage,
  WorkspaceAuthoringService,
} from '../src/index.ts'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'

const principal: AuthPrincipal = {
  userId: 'user-1',
  sessionId: 'session-1',
  clientType: 'browser',
  workspaceId: 'workspace-1',
  roles: ['editor'],
  actorType: 'user',
}
const workerPrincipal: AuthPrincipal = { ...principal, actorType: 'agent', agentPrincipalId: 'agent-1' }

describe('novel authoring permissions', () => {
  it('rejects stale publication bases before opening a database transaction', () => {
    expect(() => assertOptimisticVersion(4, 3)).toThrow('version conflict')
    expect(() => assertOptimisticVersion(4, 4)).not.toThrow()
  })

  it('allows only reviewer or publication-service proposal transitions', () => {
    expect(() => assertProposalReviewTransition('draft', 'approved', 'user')).not.toThrow()
    expect(() => assertProposalReviewTransition('draft', 'rejected', 'user')).not.toThrow()
    expect(() => assertProposalReviewTransition('rejected', 'draft', 'user')).not.toThrow()
    expect(() => assertProposalReviewTransition('approved', 'published', 'service')).not.toThrow()
    expect(() => assertProposalReviewTransition('draft', 'published', 'agent')).toThrow('invalid proposal transition')
    expect(() => assertProposalReviewTransition('draft', 'approved', 'agent')).toThrow('invalid proposal transition')
  })

  it('ranks published and relevant context before draft-only context', () => {
    const selected = rankContextCandidates([
      { sourceType: 'chapter_summary', sourceId: 'draft', status: 'draft', relevanceScore: 1, recencyScore: 10 },
      { sourceType: 'story_fact', sourceId: 'published', status: 'published', relevanceScore: 1, recencyScore: 1 },
      { sourceType: 'character', sourceId: 'relevant', status: 'published', relevanceScore: 3, recencyScore: 1 },
    ], 2)
    expect(selected.map(item => item.sourceId)).toEqual(['relevant', 'published'])
  })

  it('accepts only the generation-run transitions supported by workers', () => {
    expect(() => assertGenerationRunTransition('queued', 'running')).not.toThrow()
    expect(() => assertGenerationRunTransition('running', 'completed')).not.toThrow()
    expect(() => assertGenerationRunTransition('running', 'failed')).not.toThrow()
    expect(() => assertGenerationRunTransition('running', 'cancelled')).not.toThrow()
    expect(() => assertGenerationRunTransition('queued', 'completed')).toThrow('invalid generation run state transition')
    expect(() => assertGenerationRunTransition('completed', 'running')).toThrow('invalid generation run state transition')
  })

  it('requires an object-storage capability for large chapter versions', async () => {
    const service = new LongformAuthoringService({} as never, workerPrincipal)
    await expect(service.createChapterVersionDraft({
      workspaceId: 'workspace-1', novelId: 'novel-1', chapterId: 'chapter-1', generationRunId: 'run-1', versionNo: 1,
      contentSha256: 'a'.repeat(64), contentBytes: 2 * 1024 * 1024, contentStorageKind: 'object_storage',
      contentObjectKey: 'novels/novel-1/chapter-1/v1', idempotencyKey: 'large-1',
    })).rejects.toThrow('object storage is required')
  })

  it('rejects chapter storage metadata that cannot be recovered', () => {
    expect(() => validateChapterContentStorage({
      contentSha256: 'a'.repeat(64),
      contentBytes: 7,
      contentStorageKind: 'postgres_text',
      contentText: 'chapter',
    })).not.toThrow()
    expect(() => validateChapterContentStorage({
      contentSha256: 'a'.repeat(64),
      contentBytes: 2 * 1024 * 1024,
      contentStorageKind: 'object_storage',
      contentObjectKey: 'novels/n1/chapters/c1/v1',
    })).not.toThrow()
    expect(() => validateChapterContentStorage({
      contentSha256: 'a'.repeat(64),
      contentBytes: 2 * 1024 * 1024,
      contentStorageKind: 'postgres_text',
      contentText: 'chapter',
    })).toThrow('object storage is required')
    expect(() => validateChapterContentStorage({
      contentSha256: 'not-a-sha',
      contentBytes: 7,
      contentStorageKind: 'postgres_text',
      contentText: 'chapter',
    })).toThrow('SHA-256')
  })

  it('accepts an editor principal for draft creation', () => {
    expect(() => assertDraftAuthor(principal)).not.toThrow()
  })

  it('rejects a member principal and an unbound agent', () => {
    expect(() => assertDraftAuthor({ ...principal, roles: ['member'] })).toThrow('editor permission')
    expect(() => assertDraftAuthor({ ...principal, roles: ['editor'], actorType: 'agent' })).toThrow('agent principal')
  })

  it('requires an explicitly bound agent for generation writes and lifecycle updates', () => {
    expect(() => assertGenerationWorker(principal)).toThrow('generation worker')
    expect(() => assertGenerationWorker({ ...principal, actorType: 'agent' })).toThrow('generation worker')
    expect(() => assertGenerationWorker({ ...principal, roles: ['member'], actorType: 'agent', agentPrincipalId: 'agent-1' })).toThrow('editor permission')
    expect(() => assertGenerationWorker({ ...principal, actorType: 'agent', agentPrincipalId: 'agent-1' })).not.toThrow()
  })

  it('exposes draft writers for every fixed novel entity type', () => {
    for (const method of [
      'createSkillDraft', 'createLocationDraft', 'createFactionDraft',
      'createItemDraft', 'createStorylineDraft', 'createOutlineDraft',
      'createEntityRelationDraft', 'createCharacterSkillDraft',
      'createStoryFactDraft', 'createTimelineEventDraft', 'createChapterSummaryDraft',
    ]) {
      expect(typeof (NovelAuthoringService.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('exposes workspace and novel lifecycle operations', () => {
    for (const method of ['createWorkspace', 'listWorkspaces', 'createNovel', 'changeMemberRole', 'inviteMember', 'revokeMember', 'listMembers', 'transferOwnership', 'archiveWorkspace', 'restoreWorkspace']) {
      expect(typeof (WorkspaceAuthoringService.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('exposes persistent chapter and context operations', () => {
    for (const method of ['createChapterDraft', 'createChapterVersionDraft', 'recordContextItems', 'selectAndRecordContext', 'listContextItems']) {
      expect(typeof (LongformAuthoringService.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('exposes review publication and rollback operations', () => {
    for (const method of ['publish', 'rollback']) {
      expect(typeof (ProposalPublicationService.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })
})
