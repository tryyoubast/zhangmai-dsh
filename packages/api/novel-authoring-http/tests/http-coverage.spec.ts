import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthPrincipal, AuthHttpRequest } from '@deepseek-ai/dsh-user-auth'
import { describe, expect, it, vi } from 'vitest'
import { apply, NovelAuthoringHttpController, type NovelAuthoringHttpServices } from '../src/index.ts'

const principal: AuthPrincipal = { userId: 'user', sessionId: 'session', workspaceId: 'workspace', clientType: 'browser', actorType: 'user', roles: ['owner'] }
const worker: AuthPrincipal = { ...principal, actorType: 'agent', agentPrincipalId: 'agent' }

function services(): NovelAuthoringHttpServices {
  return {
    workspace: {
      createWorkspace: vi.fn(async () => 'created'), listWorkspaces: vi.fn(async () => []), createNovel: vi.fn(async () => 'novel'),
      inviteMember: vi.fn(async () => undefined), listMembers: vi.fn(async () => []), changeMemberRole: vi.fn(async () => undefined),
      revokeMember: vi.fn(async () => undefined), transferOwnership: vi.fn(async () => undefined),
      archiveWorkspace: vi.fn(async () => undefined), restoreWorkspace: vi.fn(async () => undefined),
    },
    authoring: { createGenerationRun: vi.fn(async () => 'run'), createDraftProposal: vi.fn(async () => 'proposal') },
    longform: { listContextItems: vi.fn(async () => []) },
    review: { review: vi.fn(async () => undefined), bindTarget: vi.fn(async () => undefined) },
    publication: { publish: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined) },
  }
}

describe('authoring HTTP validation and optional routes', () => {
  it.each([undefined, null, [], 12, '{bad', 'null', '[]', '12'])('rejects workspace names from an invalid request body %j', async (body) => {
    const deps = services()
    expect((await new NovelAuthoringHttpController(principal, deps).handle({ method: 'POST', path: '/api/workspaces', body })).status).toBe(400)
    expect(deps.workspace.createWorkspace).not.toHaveBeenCalled()
  })
  it('accepts serialized object bodies and normalizes method case', async () => {
    const deps = services()
    const response = await new NovelAuthoringHttpController(principal, deps).handle({ method: 'post', path: '/api/workspaces', body: '{"name":"Book"}' })
    expect(response.body).toBe('{"ok":true,"id":"created"}')
    expect(deps.workspace.createWorkspace).toHaveBeenCalledWith({ name: 'Book' })
  })
  it.each([
    { method: 'GET', path: '/api/workspaces/workspace/members' },
    { method: 'PATCH', path: '/api/workspaces/workspace/members/member', body: { role: 'admin' } },
    { method: 'DELETE', path: '/api/workspaces/workspace/members/member' },
    { method: 'POST', path: '/api/workspaces/workspace', body: { action: 'transfer-ownership', userId: 'successor' } },
    { method: 'POST', path: '/api/workspaces/workspace', body: { action: 'archive' } },
    { method: 'POST', path: '/api/workspaces/workspace', body: { action: 'restore' } },
    { method: 'POST', path: '/api/workspaces/workspace/novels', body: { title: 'Book' } },
    { method: 'POST', path: '/api/proposals/proposal/publish' },
    { method: 'POST', path: '/api/proposals/proposal/rollback', body: { targetType: 'characters', targetId: 'character', versionNo: 1 } },
    { method: 'GET', path: '/api/novels/novel/context/run' },
  ])('routes $method $path to its authenticated service', async (request) => {
    expect((await new NovelAuthoringHttpController(principal, services()).handle(request)).status).toBe(200)
  })
  it.each([
    { method: 'POST', path: '/api/workspaces/workspace/members', body: { role: 'editor' } },
    { method: 'POST', path: '/api/workspaces/workspace/members', body: { userId: 'member', role: 'owner' } },
    { method: 'PATCH', path: '/api/workspaces/workspace/members/member', body: {} },
    { method: 'POST', path: '/api/workspaces/workspace', body: { action: 'unknown' } },
    { method: 'GET', path: '/other' },
  ])('returns 404 for invalid optional route $method $path', async (request) => {
    expect((await new NovelAuthoringHttpController(principal, services()).handle(request)).status).toBe(404)
  })
  it.each([
    { method: 'POST', path: '/api/workspaces/workspace/members', body: { userId: 'member', role: 'member' } },
    { method: 'GET', path: '/api/workspaces/workspace/members' },
    { method: 'PATCH', path: '/api/workspaces/workspace/members/member', body: { role: 'member' } },
    { method: 'DELETE', path: '/api/workspaces/workspace/members/member' },
    { method: 'POST', path: '/api/workspaces/workspace', body: { action: 'transfer-ownership', userId: 'member' } },
    { method: 'POST', path: '/api/workspaces/workspace', body: { action: 'archive' } },
    { method: 'POST', path: '/api/workspaces/workspace', body: { action: 'restore' } },
  ])('returns 404 when an optional workspace capability is absent: $method $path', async (request) => {
    const deps = services()
    const minimal = {
      ...deps, workspace: {
        createWorkspace: deps.workspace.createWorkspace,
        listWorkspaces: deps.workspace.listWorkspaces, createNovel: deps.workspace.createNovel,
      },
    }
    expect((await new NovelAuthoringHttpController(principal, minimal).handle(request)).status).toBe(404)
  })
  it.each([
    { path: '/api/workspaces/workspace', body: { action: 'transfer-ownership' } },
    { path: '/api/workspaces/workspace/novels', body: {} },
    { path: '/api/proposals/proposal/review', body: {} },
    { path: '/api/proposals/proposal/review', body: { decision: 'published' } },
    { path: '/api/proposals/proposal/rollback', body: {} },
    { path: '/api/proposals/proposal/rollback', body: { targetType: 'characters' } },
    { path: '/api/proposals/proposal/rollback', body: { targetType: 'characters', targetId: 'c', versionNo: '1' } },
  ])('rejects missing required route fields at $path', async (request) => {
    expect((await new NovelAuthoringHttpController(principal, services()).handle({ method: 'POST', ...request })).status).toBe(400)
  })
  const generation = { workspaceId: 'workspace', instruction: 'Write', idempotencyKey: 'retry' }
  it.each([{ instruction: null }, { idempotencyKey: '' }, { contextLimit: -1 }, { contextLimit: 1.5 }, { contextLimit: 129 }])('rejects invalid durable generation %j', async (override) => {
    expect((await new NovelAuthoringHttpController(principal, services()).handle({ method: 'POST', path: '/api/novels/novel/generation-runs', body: { ...generation, ...override } })).status).toBe(400)
  })
  it('preserves explicit generation settings and applies defaults to missing settings', async () => {
    const deps = services()
    const controller = new NovelAuthoringHttpController(principal, deps)
    for (const body of [generation, { ...generation, contextLimit: 0, model: 'model', promptVersion: 'v2', sourceSessionId: 'source' }]) {
      expect((await controller.handle({ method: 'POST', path: '/api/novels/novel/generation-runs', body })).status).toBe(200)
    }
    expect(deps.authoring.createGenerationRun).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'configured-provider', promptVersion: 'v1', contextLimit: 8 }))
    expect(deps.authoring.createGenerationRun).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'model', promptVersion: 'v2', contextLimit: 0, sourceSessionId: 'source' }))
    expect((await controller.handle({ method: 'POST', path: '/api/novels/novel/generation-runs', body: { instruction: 'Write', idempotencyKey: 'retry' } })).status).toBe(403)
  })
  it.each([{ instruction: null }, { idempotencyKey: '' }, { limit: -1 }, { limit: 1.5 }])('rejects invalid workflow fields %j', async (override) => {
    expect((await new NovelAuthoringHttpController(worker, services()).handle({ method: 'POST', path: '/api/novels/novel/generate', body: { ...generation, ...override } })).status).toBe(400)
  })
  it('returns 404 when an agent workflow is not installed', async () => {
    expect((await new NovelAuthoringHttpController(worker, services()).handle({ method: 'POST', path: '/api/novels/novel/generate', body: generation })).status).toBe(404)
    expect((await new NovelAuthoringHttpController(worker, services()).handle({ method: 'POST', path: '/api/novels/novel/generate', body: { instruction: 'Write', idempotencyKey: 'retry' } })).status).toBe(403)
  })
  it('preserves optional proposal fields and replaces invalid object fields with empty objects', async () => {
    const deps = services()
    const controller = new NovelAuthoringHttpController(worker, deps)
    const proposal = { ...generation, targetType: 'characters', generationRunId: 'run' }
    for (const extra of [
      { targetId: 'character', baseVersionNo: 2, operation: 'update', conflictResult: { version: 2 }, proposedContent: { name: 'Mira' }, validationResult: { valid: true } },
      { proposedContent: [], validationResult: null, conflictResult: [] },
    ]) expect((await controller.handle({ method: 'POST', path: '/api/novels/novel/proposals', body: { ...proposal, ...extra } })).status).toBe(200)
    expect(deps.authoring.createDraftProposal).toHaveBeenNthCalledWith(1, expect.objectContaining({ targetId: 'character', baseVersionNo: 2, operation: 'update', conflictResult: { version: 2 }, proposedContent: { name: 'Mira' } }))
    expect(deps.authoring.createDraftProposal).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: 'create', proposedContent: {}, validationResult: {} }))
    for (const field of ['generationRunId', 'idempotencyKey']) expect((await controller.handle({ method: 'POST', path: '/api/novels/novel/proposals', body: { ...proposal, [field]: '' } })).status).toBe(400)
    expect((await controller.handle({ method: 'POST', path: '/api/novels/novel/proposals', body: { targetType: 'characters' } })).status).toBe(403)
  })
  it.each([{ error: new Error('permission denied'), status: 403 }, { error: new Error('version conflict'), status: 409 }, { error: new Error('private database outage'), status: 500 }, { error: 'private failure', status: 500 }])('maps safe domain and infrastructure errors to $status', async ({ error, status }) => {
    const deps = services()
    const controller = new NovelAuthoringHttpController(principal, {
      ...deps, workspace: { ...deps.workspace, createWorkspace: async () => { throw error } },
    })
    const response = await controller.handle({ method: 'POST', path: '/api/workspaces', body: { name: 'Book' } })
    expect(response.status).toBe(status)
    expect(response.body).not.toContain('private')
  })
})

describe('HTTP stream adapter failure paths', () => {
  type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>
  function install(controller: unknown, maxBodyBytes?: number) {
    let handler: Handler | undefined
    const ctx = {
      effect: (effect: () => void) => { effect() }, get: () => controller,
      webServer: { register: (route: { handler: Handler }) => { handler = route.handler; return () => undefined } },
    }
    apply(ctx as unknown as Context, maxBodyBytes === undefined ? undefined : { maxBodyBytes })
    if (handler === undefined) throw new Error('missing handler')
    return handler
  }
  function response() {
    const captured = { statusCode: 200, body: '', headers: new Map<string, string>() }
    const value = {
      statusCode: 200, setHeader: (name: string, text: string) => { captured.headers.set(name, text) },
      end: (body: string) => { captured.statusCode = value.statusCode; captured.body = body },
    }
    return { value: value as unknown as ServerResponse, captured }
  }
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid configured body ceiling %s', (maxBodyBytes) => {
    expect(() => install(undefined, maxBodyBytes)).toThrow('positive safe integer')
  })
  it('defaults empty requests and combines repeated header values', async () => {
    const seen: AuthHttpRequest[] = []
    const handler = install({ handle: async (request: AuthHttpRequest) => { seen.push(request); return { status: 204, headers: {}, body: '' } } })
    const request = Object.assign(Readable.from([]), { headers: { 'x-values': ['one', 'two'] }, socket: {} }) as unknown as IncomingMessage
    await handler(request, response().value)
    expect(seen).toEqual([{ method: 'GET', path: '/', headers: { 'x-values': 'one, two' } }])
  })
  it('accepts decoded string chunks and rejects interrupted streams before dispatch', async () => {
    const handle = vi.fn(async () => ({ status: 200, headers: {}, body: '{}' }))
    const handler = install({ handle })
    const valid = Object.assign(Readable.from(['{"value":', '1}']), { headers: {}, socket: {} }) as unknown as IncomingMessage
    await handler(valid, response().value)
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ body: { value: 1 } }))
    const stream = Readable.from((async function* () { yield '{'; throw new Error('interrupted') })())
    const broken = Object.assign(stream, { headers: {}, socket: {} }) as unknown as IncomingMessage
    const reply = response()
    await handler(broken, reply.value)
    expect(reply.captured.statusCode).toBe(400)
    expect(handle).toHaveBeenCalledTimes(1)
  })
  it('reports an unavailable composition service after a bounded read', async () => {
    const request = Object.assign(Readable.from([]), { headers: {}, socket: {} }) as unknown as IncomingMessage
    await expect(install(undefined)(request, response().value)).rejects.toThrow('platformHttpController is unavailable')
  })
})
