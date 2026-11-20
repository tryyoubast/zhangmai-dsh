import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseClient, DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import type { Redis } from 'ioredis'
import type { Transporter } from 'nodemailer'
import type { AuthPrincipal, AuthHttpRequest } from '@deepseek-ai/dsh-user-auth'
import { checkDatabase, createApiController, createProvider, createWorkerDelivery, openDatabase, readSecret, safeController } from '../src/runtime.ts'
import { config } from './config-fixture.ts'

const captured = vi.hoisted(() => ({
  platform: undefined as unknown, auth: undefined as unknown, principal: undefined as unknown,
  mail: undefined as unknown, security: undefined as unknown, adapter: undefined as unknown,
  database: vi.fn(), resolveIdentity: vi.fn(), resolveForRestore: vi.fn(), onboard: vi.fn(), workerIdentity: vi.fn(),
  writerCalls: [] as Array<{ name: string; principal: unknown; input: unknown }>,
}))

vi.mock('@deepseek-ai/dsh-database-postgres', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-database-postgres')>(),
  createDatabase: captured.database,
}))
vi.mock('@deepseek-ai/dsh-api-novel-authoring-http', () => ({
  PlatformHttpController: function (services: unknown) { captured.platform = services },
}))
vi.mock('@deepseek-ai/dsh-user-auth', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-user-auth')>()
  return { ...actual,
    AuthHttpController: class {
      constructor(_auth: unknown, _refresh: unknown, options: unknown) { captured.auth = options }
      handle(request: AuthHttpRequest) { return request }
    },
    AuthSecurityControls: function (rate: unknown) { captured.security = rate },
    AuthTemplateMailProvider: function (delivery: unknown) { captured.mail = delivery },
    resolveAuthPrincipal: (input: unknown) => { captured.principal = input; return null },
  }
})
vi.mock('@deepseek-ai/dsh-novel-authoring', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-novel-authoring')>()
  const authoringNames = [
    'createDraftProposal', 'createCharacterDraft', 'createSkillDraft', 'createLocationDraft', 'createFactionDraft',
    'createItemDraft', 'createStorylineDraft', 'createOutlineDraft', 'createEntityRelationDraft', 'createCharacterSkillDraft',
    'createStoryFactDraft', 'createTimelineEventDraft', 'createChapterSummaryDraft', 'updateGenerationRunStatus',
  ]
  const service = (names: string[]) => function (this: object, _database: unknown, principal: unknown) {
    for (const name of names) Object.defineProperty(this, name, { value: async (input: unknown) => {
      captured.writerCalls.push({ name, principal, input })
      return name
    } })
  }
  return { ...actual,
    PostgresWorkspaceIdentity: class {
      onboard = captured.onboard
      resolve = captured.resolveIdentity
      resolveForRestore = captured.resolveForRestore
    },
    PostgresGenerationWorkerIdentity: class { resolve = captured.workerIdentity },
    NovelAuthoringService: service(authoringNames), LongformAuthoringService: service(['createChapterDraft', 'createChapterVersionDraft']),
    GenerationMaterializationService: class {
      constructor(readonly writers: Record<string, (input: unknown) => Promise<unknown>>) {}
      async materialize() {
        for (const [name, writer] of Object.entries(this.writers)) expect(await writer({ record: name })).toBe(name)
      }
    },
    NovelGenerationWorkflowService: class {
      constructor(readonly services: { materialization: { materialize(): Promise<void> } }) {}
      async executeQueued() { await this.services.materialization.materialize() }
    },
    DeepSeekNovelGenerationAdapter: function (options: unknown) { captured.adapter = options },
  }
})

let directory: string | undefined
afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  captured.writerCalls = []
  vi.unstubAllGlobals()
})
const database = (execute = vi.fn()): DatabaseClient<DshDatabase> => ({ db: { execute } }) as unknown as DatabaseClient<DshDatabase>
async function secrets(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'dsh-novel-runtime-'))
  const pair = generateKeyPairSync('ed25519')
  await writeFile(join(directory, 'access-private.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(join(directory, 'access-public.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }))
  return directory
}

describe('novel host runtime composition', () => {
  it('reads only nonempty mounted secrets and redacts missing or empty files', async () => {
    const root = await secrets()
    await writeFile(join(root, 'auth-password'), '  password with punctuation @:/  \n')
    captured.database.mockReturnValue('pool')
    expect(await readSecret(root, 'auth-password')).toBe('password with punctuation @:/')
    expect(await openDatabase(config(root), 'auth')).toBe('pool')
    const settings = captured.database.mock.calls.at(-1)![0] as { url: string; runtimeRole: string }
    expect(new URL(settings.url).password).toBe('password%20with%20punctuation%20%40%3A%2F')
    expect(settings.runtimeRole).toBe('dsh_auth_runtime')
    await writeFile(join(root, 'empty'), '\n  ')
    await expect(readSecret(root, 'empty')).rejects.toThrow('required secret empty is unavailable')
    await expect(readSecret(root, 'missing')).rejects.toThrow('required secret missing is unavailable')
  })

  it.each([[], [{ role: 'wrong', ready: true }], [{ role: 'dsh_worker_runtime', ready: false }]].map(rows => [rows]))('rejects missing schema or mismatched runtime identity', async (rows) => {
    await expect(checkDatabase(database(vi.fn().mockResolvedValue({ rows })), 'dsh_worker_runtime')).rejects.toThrow('required database capabilities')
  })

  it('accepts the expected role with all required catalog capabilities', async () => {
    await expect(checkDatabase(database(vi.fn().mockResolvedValue({ rows: [{ role: 'dsh_worker_runtime', ready: true }] })), 'dsh_worker_runtime')).resolves.toBeUndefined()
  })

  it('keeps each request identity resolver local, forwards SMTP text, and sends locator-only notifications', async () => {
    const root = await secrets()
    const redis = { call: vi.fn(async () => 'OK') }
    const mail = { sendMail: vi.fn(async () => ({})) }
    await createApiController(config(root), { auth: database(), app: database(), service: database() },
      redis as unknown as Redis, mail as unknown as Transporter)
    const platform = captured.platform as {
      auth: { handle(request: AuthHttpRequest): unknown }
      resolvePrincipal(request: AuthHttpRequest, restoreWorkspaceId?: string): unknown
      authoring(principal: AuthPrincipal): { notifyGeneration(input: unknown): Promise<void> }
    }
    const login = { method: 'POST', path: '/api/auth/login', headers: {} }
    expect(platform.auth.handle(login)).toBe(login)
    await (captured.auth as { resolveIdentity(user: string): Promise<unknown> }).resolveIdentity('user')
    expect(captured.onboard).toHaveBeenCalledWith('user')
    const ordinary = { method: 'GET', path: '/api/workspaces', headers: { 'x-dsh-workspace-id': 'selected' } }
    platform.resolvePrincipal(ordinary)
    await (captured.principal as { resolveIdentity(user: string): Promise<unknown> }).resolveIdentity('user')
    expect(captured.resolveIdentity).toHaveBeenCalledWith('user', 'selected')
    const archived = { workspaceId: 'archived', roles: ['owner'] }
    captured.resolveForRestore.mockResolvedValueOnce(archived).mockResolvedValueOnce(null)
    platform.resolvePrincipal(ordinary, 'archived')
    const resolver = captured.principal as { resolveIdentity(user: string): Promise<unknown> }
    const resolve = (user: string) => resolver.resolveIdentity(user)
    await expect(resolve('user')).resolves.toEqual(archived)
    expect(captured.resolveForRestore).toHaveBeenCalledWith('user', 'archived')
    await resolve('user')
    expect(captured.resolveIdentity).toHaveBeenLastCalledWith('user', 'archived')
    const delivery = captured.mail as { send(input: { to: string; template: string; token: string; expiresAt: Date }): Promise<void> }
    await delivery.send({ to: 'user@example.test', template: 'verify-email', token: 'one-use-token', expiresAt: new Date('2030-01-01Z') })
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'user@example.test', text: 'verify-email\nToken: one-use-token\nExpires: 2030-01-01T00:00:00.000Z\n' }))
    const rate = captured.security as { consume(key: string, limit: number, window: number): Promise<boolean> }
    await rate.consume('auth:user', 5, 1000)
    expect(redis.call).toHaveBeenCalledWith('EVAL', expect.any(String), '1', 'auth:user', '5', '1000')
    await platform.authoring({} as AuthPrincipal).notifyGeneration({ workspaceId: 'workspace', generationRunId: 'run' })
    expect(redis.call).toHaveBeenLastCalledWith('XADD', 'dsh:novel:generation', '*', 'workspaceId', 'workspace', 'generationRunId', 'run')
  })

  it.each(['missing', 'mismatched', 'rsa'])('rejects unavailable or invalid signing key pairs: %s', async (kind) => {
    const root = await secrets()
    if (kind === 'missing') await rm(join(root, 'access-private.pem'))
    else {
      const pair = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519')
      await writeFile(join(root, 'access-public.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }))
    }
    await expect(createApiController(config(root), { auth: database(), app: database(), service: database() }, {} as Redis, {} as Transporter)).rejects.toThrow('Ed25519 access key pair is unavailable')
  })

  it('wires each draft writer to the currently resolved worker principal', async () => {
    const principal = { userId: 'user', agentPrincipalId: 'novel-worker' }
    captured.workerIdentity.mockResolvedValue({ status: 'queued', principal })
    const deliver = createWorkerDelivery(database(), {} as Awaited<ReturnType<typeof createProvider>>)
    const fields = ['workspaceId', '11111111-1111-4111-8111-111111111111', 'generationRunId', '22222222-2222-4222-8222-222222222222']
    expect(await deliver(fields)).toBe('ack')
    expect(captured.writerCalls).toHaveLength(15)
    expect(captured.writerCalls.every(call => call.principal === principal)).toBe(true)
    captured.workerIdentity.mockResolvedValue({ status: 'running', principal })
    expect(await deliver(fields)).toBe('ack')
    expect(captured.writerCalls.at(-1)?.name).toBe('updateGenerationRunStatus')
    expect(captured.writerCalls.at(-1)?.principal).toBe(principal)
    expect(captured.writerCalls.at(-1)?.input).toMatchObject({ status: 'failed', errorCode: 'GENERATION_INTERRUPTED' })
  })

  it('settles a delivery with unavailable authority before acknowledging it and retains a database failure', async () => {
    captured.workerIdentity.mockResolvedValue(null)
    const execute = vi.fn().mockResolvedValue({ rows: [{ acknowledge: true }] })
    const tx = { execute }
    const pool = {
      db: { transaction: (work: (database: typeof tx) => Promise<unknown>) => work(tx) },
    } as unknown as DatabaseClient<DshDatabase>
    const deliver = createWorkerDelivery(pool, {} as Awaited<ReturnType<typeof createProvider>>)
    const fields = ['workspaceId', '11111111-1111-4111-8111-111111111111', 'generationRunId', '22222222-2222-4222-8222-222222222222']
    expect(await deliver(fields)).toBe('ack')
    expect(execute).toHaveBeenCalledTimes(5)
    execute.mockResolvedValue({ rows: [{ acknowledge: false }] })
    expect(await deliver(fields)).toBe('retain')
    execute.mockResolvedValue({ rows: [] })
    expect(await deliver(fields)).toBe('retain')
    execute.mockRejectedValue(new Error('database unavailable'))
    expect(await deliver(fields)).toBe('retain')
  })

  it('isolates fixture credentials and combines provider and ownership cancellation', async () => {
    const root = await secrets()
    await writeFile(join(root, 'deepseek-api-key'), 'real-operator-key')
    const ownership = new AbortController()
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetcher)
    await createProvider(config(root), ownership.signal)
    let options = captured.adapter as { apiKey: string; fetch: typeof fetch }
    expect(options.apiKey).toBe('fixture-only')
    await options.fetch('http://model:8081/v1')
    expect(fetcher).toHaveBeenLastCalledWith('http://model:8081/v1', { signal: ownership.signal })
    await options.fetch('http://model:8081/v1', { signal: null })
    const request = new AbortController()
    await options.fetch('http://model:8081/v1', { signal: request.signal })
    const combined = fetcher.mock.calls.at(-1)![1]!.signal!
    expect(combined.aborted).toBe(false)
    ownership.abort()
    expect(combined.aborted).toBe(true)
    const settings = config(root)
    await createProvider(Object.assign({}, settings, { provider: Object.assign({}, settings.provider, { url: 'https://api.deepseek.com/v1' }) }),
      new AbortController().signal)
    options = captured.adapter as typeof options
    expect(options.apiKey).toBe('real-operator-key')
  })

  it('preserves successful HTTP responses and replaces rejected infrastructure details', async () => {
    const response = { status: 204, headers: {}, body: '' }
    const request = { method: 'GET', path: '/api/workspaces', headers: {} }
    expect(await safeController({ handle: async () => response }).handle(request)).toBe(response)
    const failed = await safeController({ handle: async () => { throw new Error('postgres password=secret') } }).handle(request)
    expect(failed).toEqual({ status: 503, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"error":"service_unavailable"}' })
  })
})
