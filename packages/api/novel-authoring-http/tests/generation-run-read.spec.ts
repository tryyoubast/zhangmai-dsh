import { describe, expect, it, vi } from 'vitest'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import { NovelAuthoringHttpController, type NovelAuthoringHttpServices } from '../src/index.ts'

const principal: AuthPrincipal = {
  userId: 'user', sessionId: 'authenticated-session', workspaceId: 'workspace',
  clientType: 'browser', actorType: 'user', roles: ['editor'],
}

function services(): NovelAuthoringHttpServices {
  return {
    workspace: { createWorkspace: async () => 'workspace', listWorkspaces: async () => [], createNovel: async () => 'novel' },
    authoring: { createGenerationRun: vi.fn(async () => 'run'), createDraftProposal: async () => 'proposal' },
    longform: { listContextItems: async () => [] },
    review: { review: async () => undefined, bindTarget: async () => undefined },
    publication: { publish: async () => undefined, rollback: async () => undefined },
  }
}

describe('generation run HTTP reads', () => {
  it.each(['queued', 'running', 'completed', 'failed', 'cancelled'] as const)('reads %s state and safe proposal locators using authenticated workspace and route novel', async (status) => {
    const getGenerationRun = vi.fn(async () => ({
      runId: 'run', status, instruction: 'private prompt', errorSummary: 'private provider key',
      proposals: [{ id: 'proposal', targetType: 'characters' as const, targetId: 'character', status: 'draft' as const, proposedContent: { private: 'raw model output' } }],
    }))
    const deps = services()
    const controller = new NovelAuthoringHttpController(principal, { ...deps, authoring: { ...deps.authoring, getGenerationRun } })
    const reply = await controller.handle({ method: 'GET', path: '/api/novels/novel/generation-runs/run?workspaceId=foreign', body: { workspaceId: 'foreign' } })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({
      ok: true, runId: 'run', status,
      proposals: [{ id: 'proposal', targetType: 'characters', targetId: 'character', status: 'draft' }],
    })
    expect(getGenerationRun).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', novelId: 'novel', generationRunId: 'run' })
  })

  it('returns the same safe 404 for invisible runs and an absent read capability', async () => {
    const deps = services()
    for (const authoring of [deps.authoring, { ...deps.authoring, getGenerationRun: async () => undefined }]) {
      const reply = await new NovelAuthoringHttpController(principal, { ...deps, authoring }).handle({ method: 'GET', path: '/api/novels/foreign-novel/generation-runs/run' })
      expect(reply.status).toBe(404)
      expect(reply.body).toBe('{"error":"not_found"}')
    }
  })

  it('does not reveal raw database or provider exceptions on read failure', async () => {
    const deps = services()
    const controller = new NovelAuthoringHttpController(principal, {
      ...deps, authoring: { ...deps.authoring, getGenerationRun: async () => { throw new Error('private key provider outage') } },
    })
    const reply = await controller.handle({ method: 'GET', path: '/api/novels/novel/generation-runs/run' })
    expect(reply.status).toBe(500)
    expect(reply.body).toBe('{"error":"authoring_unavailable"}')
  })
})

describe.each([{ endpoint: 'generate', successStatus: 202 }, { endpoint: 'generation-runs', successStatus: 200 }])('browser $endpoint source session', ({ endpoint, successStatus }) => {
  it('persists the authenticated session when the browser omits sourceSessionId', async () => {
    const deps = services()
    const reply = await new NovelAuthoringHttpController(principal, deps).handle({
      method: 'POST', path: `/api/novels/novel/${endpoint}`,
      body: { workspaceId: 'workspace', instruction: 'Write', idempotencyKey: 'retry' },
    })
    expect(reply.status).toBe(successStatus)
    expect(deps.authoring.createGenerationRun).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: principal.sessionId }))
  })

  it('accepts an explicitly matching authenticated session', async () => {
    const deps = services()
    const reply = await new NovelAuthoringHttpController(principal, deps).handle({
      method: 'POST', path: `/api/novels/novel/${endpoint}`,
      body: { workspaceId: 'workspace', instruction: 'Write', idempotencyKey: 'retry', sourceSessionId: principal.sessionId },
    })
    expect(reply.status).toBe(successStatus)
    expect(deps.authoring.createGenerationRun).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: principal.sessionId }))
  })

  it.each(['foreign-session', null, 42])('rejects a supplied source session %j that differs from the authenticated session', async (sourceSessionId) => {
    const deps = services()
    const reply = await new NovelAuthoringHttpController(principal, deps).handle({
      method: 'POST', path: `/api/novels/novel/${endpoint}`,
      body: { workspaceId: 'workspace', instruction: 'Write', idempotencyKey: 'retry', sourceSessionId },
    })
    expect(reply.status).toBe(400)
    expect(deps.authoring.createGenerationRun).not.toHaveBeenCalled()
  })
})
