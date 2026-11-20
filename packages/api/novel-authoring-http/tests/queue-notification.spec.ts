import { describe, expect, it, vi } from 'vitest'
import { NovelAuthoringHttpController, PlatformHttpController, type NovelAuthoringHttpServices } from '../src/index.ts'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'

const principal: AuthPrincipal = {
  userId: 'user', sessionId: 'session', workspaceId: 'workspace', roles: ['owner'], actorType: 'user', clientType: 'browser',
}

function services(notify: (locator: { workspaceId: string; generationRunId: string }) => Promise<void>): NovelAuthoringHttpServices {
  return {
    workspace: { createWorkspace: async () => 'w', listWorkspaces: async () => [], createNovel: async () => 'n' },
    authoring: { createGenerationRun: async () => 'persisted-run', createDraftProposal: async () => 'p' },
    notifyGeneration: notify,
    longform: { listContextItems: async () => [] },
    review: { review: async () => {}, bindTarget: async () => {} },
    publication: { publish: async () => {}, rollback: async () => {} },
  }
}

const request = {
  method: 'POST', path: '/api/novels/novel/generate',
  body: { workspaceId: 'workspace', instruction: 'private instruction', idempotencyKey: 'retry' },
}

describe('durable generation notification', () => {
  it('answers 503 without exposing broker errors, then retries the same persisted locator', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('redis password=secret')).mockResolvedValue(undefined)
    const controller = new NovelAuthoringHttpController(principal, services(notify))
    expect(await controller.handle(request)).toMatchObject({ status: 503, body: '{"error":"queue_unavailable"}' })
    expect(await controller.handle(request)).toMatchObject({ status: 202 })
    expect(notify.mock.calls).toEqual([
      [{ workspaceId: 'workspace', generationRunId: 'persisted-run' }],
      [{ workspaceId: 'workspace', generationRunId: 'persisted-run' }],
    ])
  })

  it('enqueues a browser generation-run request using the authenticated session', async () => {
    const notify = vi.fn(async () => {})
    const deps = services(notify)
    const createGenerationRun = vi.spyOn(deps.authoring, 'createGenerationRun')
    const controller = new NovelAuthoringHttpController(principal, deps)
    const reply = await controller.handle({ ...request, path: '/api/novels/novel/generation-runs' })
    expect(reply).toMatchObject({ status: 202, body: '{"ok":true,"runId":"persisted-run","status":"queued"}' })
    expect(createGenerationRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceSessionId: principal.sessionId }))
    expect(notify).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', generationRunId: 'persisted-run' })
  })

  it.each([
    { supplied: 'origin-session', persisted: 'origin-session' },
    { supplied: undefined, persisted: '00000000-0000-0000-0000-000000000000' },
  ])('preserves the agent generation-run session contract without notifying the browser queue', async ({ supplied, persisted }) => {
    const notify = vi.fn(async () => {})
    const deps = services(notify)
    const createGenerationRun = vi.spyOn(deps.authoring, 'createGenerationRun')
    const worker: AuthPrincipal = { ...principal, actorType: 'agent', agentPrincipalId: 'worker' }
    const reply = await new NovelAuthoringHttpController(worker, deps).handle({
      ...request, path: '/api/novels/novel/generation-runs', body: { ...request.body, sourceSessionId: supplied },
    })
    expect(reply).toMatchObject({ status: 200, body: '{"ok":true,"id":"persisted-run"}' })
    expect(createGenerationRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceSessionId: persisted }))
    expect(notify).not.toHaveBeenCalled()
  })

  it('never notifies after a conflicting durable request or malformed input', async () => {
    const notify = vi.fn()
    const value = services(notify)
    value.authoring.createGenerationRun = async () => { throw new Error('idempotency payload mismatch') }
    const controller = new NovelAuthoringHttpController(principal, value)
    expect((await controller.handle(request)).status).toBe(409)
    expect((await controller.handle({ ...request, body: {} })).status).toBe(403)
    expect(notify).not.toHaveBeenCalled()
  })

  it('checks business Origin before resolving or constructing authenticated services', async () => {
    const resolvePrincipal = vi.fn(async () => principal)
    const controller = new PlatformHttpController({
      allowedOrigin: 'https://localhost:8443', resolvePrincipal,
      auth: { handle: async () => ({ status: 204, headers: {}, body: '' }) },
      authoring: () => services(async () => {}),
    })
    expect((await controller.handle({ ...request, headers: { origin: 'https://evil.invalid' } })).status).toBe(403)
    expect(resolvePrincipal).not.toHaveBeenCalled()
    expect((await controller.handle({ ...request, headers: { origin: 'https://localhost:8443' } })).status).toBe(202)
  })
})
