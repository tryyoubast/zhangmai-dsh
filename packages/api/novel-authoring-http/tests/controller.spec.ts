import { describe, expect, it } from 'vitest'
import { NovelAuthoringHttpController, PlatformHttpController } from '../src/index.ts'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'

const principal: AuthPrincipal = {
  userId: 'user-1', sessionId: 'session-1', clientType: 'browser', workspaceId: 'workspace-1', roles: ['owner'], actorType: 'user',
}
const workerPrincipal: AuthPrincipal = { ...principal, actorType: 'agent', agentPrincipalId: 'agent-1' }

describe('NovelAuthoringHttpController', () => {
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
