import { describe, expect, it, vi } from 'vitest'
import { NovelAuthoringHttpController, PlatformHttpController, type NovelAuthoringHttpServices } from '../src/index.ts'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import { ProposalReviewService } from '@deepseek-ai/dsh-novel-authoring'
import { serviceDatabase } from '../../../storage/novel-authoring/tests/coverage-fixture.ts'

const principal: AuthPrincipal = {
  userId: 'user-1', sessionId: 'session-1', clientType: 'browser', workspaceId: 'workspace-1', roles: ['owner'], actorType: 'user',
}
const workerPrincipal: AuthPrincipal = { ...principal, actorType: 'agent', agentPrincipalId: 'agent-1' }

function proposalServices(createDraftProposal: NovelAuthoringHttpServices['authoring']['createDraftProposal']): NovelAuthoringHttpServices {
  return {
    workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
    authoring: { createGenerationRun: async () => 'r', createDraftProposal },
    longform: { listContextItems: async () => [] },
    review: { review: async () => undefined, bindTarget: async () => undefined },
    publication: { publish: async () => undefined, rollback: async () => undefined },
  }
}

const proposalBody = { workspaceId: 'workspace-1', generationRunId: 'run-1', idempotencyKey: 'proposal-1', operation: 'create' }

describe('NovelAuthoringHttpController', () => {
  it.each([undefined, null, '', ' ', 'unsupported', 'constructor', 'toString', '__proto__', 42, {}])('rejects proposal target %j before calling authoring', async (targetType) => {
    const createDraftProposal = vi.fn(async () => 'proposal-1')
    const controller = new NovelAuthoringHttpController(workerPrincipal, proposalServices(createDraftProposal))
    const response = await controller.handle({ method: 'POST', path: '/api/novels/n1/proposals', body: { ...proposalBody, targetType } })
    expect(response.status).toBe(400)
    expect(response.body).toBe('{"error":"invalid_request"}')
    expect(createDraftProposal).not.toHaveBeenCalled()
  })

  it.each(['outlines', 'characters', 'skills', 'locations', 'factions', 'items', 'storylines', 'entity_relations', 'character_skills', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events'])('accepts the fixed proposal target %s for a worker', async (targetType) => {
    const createDraftProposal = vi.fn(async () => 'proposal-1')
    const controller = new NovelAuthoringHttpController(workerPrincipal, proposalServices(createDraftProposal))
    const response = await controller.handle({ method: 'POST', path: '/api/novels/n1/proposals', body: { ...proposalBody, targetType } })
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"ok":true,"id":"proposal-1"}')
    expect(createDraftProposal).toHaveBeenCalledWith(expect.objectContaining({ targetType, workspaceId: 'workspace-1' }))
  })

  it('keeps proposal creation restricted to workers', async () => {
    const createDraftProposal = vi.fn(async () => 'proposal-1')
    const controller = new NovelAuthoringHttpController(principal, proposalServices(createDraftProposal))
    const response = await controller.handle({ method: 'POST', path: '/api/novels/n1/proposals', body: { ...proposalBody, targetType: 'characters' } })
    expect(response.status).toBe(404)
    expect(createDraftProposal).not.toHaveBeenCalled()
  })

  it('routes authentication and authoring through one host boundary', async () => {
    const calls: string[] = []
    const platform = new PlatformHttpController({
      auth: { handle: async (request) => { calls.push(`auth:${request.path}`); return { status: 204, headers: {}, body: '' } } },
      resolvePrincipal: async () => principal,
      authoring: () => ({
        workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
        authoring: { createGenerationRun: async () => 'r', createDraftProposal: async () => 'p' },
        longform: { listContextItems: async () => [] },
        review: { review: async () => undefined, bindTarget: async () => undefined },
        publication: { publish: async () => undefined, rollback: async () => undefined },
      }),
    })
    expect((await platform.handle({ method: 'POST', path: '/api/auth/logout', headers: {} })).status).toBe(204)
    expect((await platform.handle({ method: 'GET', path: '/api/workspaces', headers: {} })).status).toBe(200)
    expect(calls).toEqual(['auth:/api/auth/logout'])
  })

  it('rejects an unauthenticated authoring request before creating services', async () => {
    let created = false
    const platform = new PlatformHttpController({
      auth: { handle: async () => ({ status: 204, headers: {}, body: '' }) },
      resolvePrincipal: async () => null,
      authoring: () => { created = true; throw new Error('must not create') },
    })
    const response = await platform.handle({ method: 'GET', path: '/api/workspaces', headers: {} })
    expect(response.status).toBe(401)
    expect(created).toBe(false)
  })

  it('requests archived workspace authority only for the matching restore action', async () => {
    const restoreWorkspace = vi.fn(async () => {})
    const resolvePrincipal = vi.fn(async (_request: unknown, restoreWorkspaceId?: string) =>
      restoreWorkspaceId === principal.workspaceId ? principal : null)
    const services = proposalServices(async () => 'proposal')
    const platform = new PlatformHttpController({
      auth: { handle: async () => ({ status: 204, headers: {}, body: '' }) },
      allowedOrigin: 'https://test.invalid',
      resolvePrincipal,
      authoring: () => ({ ...services, workspace: { ...services.workspace, restoreWorkspace } }),
    })
    const request = { method: 'POST', path: '/api/workspaces/workspace-1', body: { action: 'restore' },
      headers: { origin: 'https://test.invalid' } }
    expect((await platform.handle({ ...request, headers: {} })).status).toBe(403)
    expect(resolvePrincipal).not.toHaveBeenCalled()
    for (const other of [
      { ...request, method: 'GET' },
      { ...request, path: '/api/workspaces/workspace-1/novels' },
      { ...request, path: '/api/other/workspace-1' },
      { ...request, body: { action: 'archive' } },
      { ...request, headers: { ...request.headers, 'x-dsh-workspace-id': 'another' } },
    ]) expect((await platform.handle(other)).status).toBe(401)
    expect(restoreWorkspace).not.toHaveBeenCalled()
    expect((await platform.handle(request)).status).toBe(200)
    expect(restoreWorkspace).toHaveBeenCalledOnce()
    expect(restoreWorkspace).toHaveBeenCalledWith(principal.workspaceId)
  })

  it('rejects a client-selected workspace outside the authenticated principal', async () => {
    const controller = new NovelAuthoringHttpController(principal, {
      workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
      authoring: { createGenerationRun: async () => 'r', createDraftProposal: async () => 'p' },
      longform: { listContextItems: async () => [] },
      review: { review: async () => undefined, bindTarget: async () => undefined },
      publication: { publish: async () => undefined, rollback: async () => undefined },
    })
    const response = await controller.handle({ method: 'POST', path: '/api/novels/n1/generation-runs', body: { workspaceId: 'workspace-2', idempotencyKey: 'x' } })
    expect(response.status).toBe(403)
  })

  it('keeps proposal review on the authenticated workspace', async () => {
    let observed: string | undefined
    const controller = new NovelAuthoringHttpController(principal, {
      workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
      authoring: { createGenerationRun: async () => 'r', createDraftProposal: async () => 'p' },
      longform: { listContextItems: async () => [] },
      review: { review: async (input) => { observed = input.workspaceId }, bindTarget: async () => undefined },
      publication: { publish: async () => undefined, rollback: async () => undefined },
    })
    const response = await controller.handle({ method: 'POST', path: '/api/proposals/p1/review', body: { decision: 'rejected' } })
    expect(response.status).toBe(200)
    expect(observed).toBe('workspace-1')
  })

  it.each(['foreign-proposal', 'missing-proposal'])('returns a uniform 404 for %s without changing review state', async (proposalId) => {
    const db = serviceDatabase()
    db.selects.push([])
    const review = new ProposalReviewService(db.database, principal)
    const lookup = vi.spyOn(review, 'review')
    const controller = new NovelAuthoringHttpController(principal, {
      ...proposalServices(async () => 'proposal'), review,
    })
    const reply = await controller.handle({
      method: 'POST', path: `/api/proposals/${proposalId}/review`,
      body: { decision: 'approved', workspaceId: 'foreign-workspace' },
    })
    expect(reply.status).toBe(404)
    expect(reply.body).toBe('{"error":"not_found"}')
    expect(lookup).toHaveBeenCalledWith({ workspaceId: principal.workspaceId, proposalId, decision: 'approved' })
    expect(db.transactions).toBe(1)
    expect(db.rollbacks).toBe(1)
    expect(db.writes).toEqual([])
  })

  it.each([
    { error: new Error('private database outage'), status: 500, code: 'authoring_unavailable' },
    { error: new Error('proposal was not found: private database failure'), status: 500, code: 'authoring_unavailable' },
    { error: 'proposal was not found', status: 500, code: 'authoring_unavailable' },
    { error: new Error('owner or administrator permission is required'), status: 403, code: 'forbidden' },
  ])('preserves review error mapping to $status for other failures', async ({ error, status, code }) => {
    const deps = proposalServices(async () => 'proposal')
    const controller = new NovelAuthoringHttpController(principal, {
      ...deps, review: { ...deps.review, review: async () => { throw error } },
    })
    const reply = await controller.handle({ method: 'POST', path: '/api/proposals/proposal/review', body: { decision: 'approved' } })
    expect(reply.status).toBe(status)
    expect(reply.body).toBe(JSON.stringify({ error: code }))
  })

  it('starts the complete generation workflow without trusting the request workspace', async () => {
    let observedWorkspace: string | undefined
    const controller = new NovelAuthoringHttpController(workerPrincipal, {
      workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
      authoring: { createGenerationRun: async () => 'r', createDraftProposal: async () => 'p' },
      generation: {
        async generate(input) {
          observedWorkspace = input.workspaceId
          return { runId: 'run-1', generation: { generationRunId: 'run-1', workspaceId: 'workspace-1', novelId: 'n1', idempotencyKey: 'idem-1', selectedContext: [], records: [], proposals: [] }, materialization: { records: [] } }
        },
      },
      longform: { listContextItems: async () => [] },
      review: { review: async () => undefined, bindTarget: async () => undefined },
      publication: { publish: async () => undefined, rollback: async () => undefined },
    })
    const response = await controller.handle({ method: 'POST', path: '/api/novels/n1/generate', body: { workspaceId: 'workspace-1', instruction: 'write', idempotencyKey: 'idem-1' } })
    expect(response.status).toBe(200)
    expect(observedWorkspace).toBe('workspace-1')
  })

  it('queues browser generation requests while keeping materialization worker-only', async () => {
    let queuedInput: Record<string, unknown> | undefined
    const controller = new NovelAuthoringHttpController(principal, {
      workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
      authoring: {
        createGenerationRun: async (input) => { queuedInput = { ...input }; return 'queued-run' },
        createDraftProposal: async () => 'p',
      },
      generation: { async generate() { throw new Error('must not run') } },
      longform: { listContextItems: async () => [] },
      review: { review: async () => undefined, bindTarget: async () => undefined },
      publication: { publish: async () => undefined, rollback: async () => undefined },
    })
    const response = await controller.handle({ method: 'POST', path: '/api/novels/n1/generate', body: { workspaceId: 'workspace-1', instruction: 'write', limit: 3, idempotencyKey: 'idem-1' } })
    expect(response.status).toBe(202)
    expect(response.body).toContain('queued-run')
    expect(queuedInput).toMatchObject({ instruction: 'write', contextLimit: 3 })
  })

  it('rejects browser generation requests without a durable instruction', async () => {
    let created = false
    const controller = new NovelAuthoringHttpController(principal, {
      workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
      authoring: {
        createGenerationRun: async () => { created = true; return 'run' },
        createDraftProposal: async () => 'p',
      },
      longform: { listContextItems: async () => [] },
      review: { review: async () => undefined, bindTarget: async () => undefined },
      publication: { publish: async () => undefined, rollback: async () => undefined },
    })
    const response = await controller.handle({
      method: 'POST',
      path: '/api/novels/n1/generation-runs',
      body: { workspaceId: 'workspace-1', idempotencyKey: 'missing-instruction' },
    })
    expect(response.status).toBe(400)
    expect(created).toBe(false)
  })

  it('routes workspace member invitations through the authenticated workspace', async () => {
    let observed: { workspaceId: string; userId: string; role: string } | undefined
    const controller = new NovelAuthoringHttpController(principal, {
      workspace: {
        createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n',
        inviteMember: async (workspaceId, userId, role) => { observed = { workspaceId, userId, role } },
      },
      authoring: { createGenerationRun: async () => 'r', createDraftProposal: async () => 'p' },
      longform: { listContextItems: async () => [] },
      review: { review: async () => undefined, bindTarget: async () => undefined },
      publication: { publish: async () => undefined, rollback: async () => undefined },
    })
    const response = await controller.handle({
      method: 'POST', path: '/api/workspaces/workspace-1/members', body: { userId: 'user-2', role: 'editor' },
    })
    expect(response.status).toBe(200)
    expect(observed).toEqual({ workspaceId: 'workspace-1', userId: 'user-2', role: 'editor' })
  })
})
