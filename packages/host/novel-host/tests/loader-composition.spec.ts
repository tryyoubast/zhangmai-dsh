import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dump } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as NovelHost from '../src/index.ts'
import { config } from './config-fixture.ts'
import type { DatabaseConfig } from '@deepseek-ai/dsh-database-postgres'

const external = vi.hoisted(() => ({
  roles: [] as string[], closed: [] as string[], ready: true, notificationFailure: false,
  queryGate: undefined as Promise<void> | undefined, queryStarted: false,
}))

vi.mock('@deepseek-ai/dsh-database-postgres', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-database-postgres')>()
  return { ...actual, createDatabase: vi.fn((settings: DatabaseConfig) => {
    external.roles.push(settings.runtimeRole)
    return {
      db: {
        execute: async () => {
          if (external.queryGate !== undefined) { external.queryStarted = true; await external.queryGate }
          if (!external.ready) throw new Error('private driver error')
          return { rows: [{ role: settings.runtimeRole, ready: true }] }
        },
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      },
      pool: Object.assign(new EventEmitter(), {
        connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release: () => { external.closed.push('lock') } }),
      }),
      close: async () => { external.closed.push(settings.runtimeRole) },
    }
  }) }
})

vi.mock('ioredis', () => ({ Redis: class extends EventEmitter {
  async connect() {}
  async ping() { if (!external.ready) throw new Error('redis secret'); return 'PONG' }
  async call(command: string) {
    if (command === 'XADD' && external.notificationFailure) throw new Error('password=secret')
    if (command === 'XAUTOCLAIM') return ['0-0', [], []]
    if (command === 'XREADGROUP') { await delay(10); return null }
    return 'OK'
  }
  disconnect() { external.closed.push('redis') }
} }))

vi.mock('nodemailer', () => ({ default: { createTransport: () => ({
  verify: async () => { if (!external.ready) throw new Error('SMTP secret'); return true },
  sendMail: async () => ({}), close: () => { external.closed.push('smtp') },
}) } }))

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  external.roles = []; external.closed = []; external.ready = true
  external.queryGate = undefined; external.queryStarted = false
})

async function boot(mode: 'api' | 'worker'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-novel-loader-'))
  const keys = generateKeyPairSync('ed25519')
  for (const name of ['auth-password', 'app-password', 'service-password', 'worker-password', 'redis-password']) {
    await writeFile(join(root, name), 'test-only-secret')
  }
  await writeFile(join(root, 'access-private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(join(root, 'access-public.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }))
  const path = join(root, 'cordis.yml')
  await writeFile(path, dump([{ id: 'novel-host', name: '@deepseek-ai/dsh-novel-host', config: config(root, mode) }]))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@deepseek-ai/dsh-novel-host') throw new Error('unexpected plugin')
      return NovelHost
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await context.loader.await()
  return context
}

describe('novel-host real Loader application', () => {
  it('serves the API and dependency readiness with separate restricted pools', async () => {
    const ctx = await boot('api')
    expect(ctx.get('webServer')).toBeDefined()
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    expect(external.roles).toEqual(['dsh_auth_runtime', 'dsh_app_runtime', 'dsh_service_runtime'])
    expect(ctx.get('platformHttpController')).toBeDefined()
    expect((await fetch(`${base}/health/live`)).status).toBe(200)
    expect((await fetch(`${base}/health/ready`)).status).toBe(200)
    expect((await fetch(`${base}/api/workspaces`)).status).toBe(401)
    const denied = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { origin: 'https://evil.invalid' }, body: '{}' })
    expect(denied.status).toBe(403)
    external.ready = false
    const notReady = await fetch(`${base}/health/ready`)
    expect(notReady.status).toBe(503)
    expect(await notReady.text()).toBe('{"ready":false}')
    await ctx.fiber.dispose()
    expect(external.closed).toEqual(expect.arrayContaining(['redis', 'smtp', 'dsh_auth_runtime', 'dsh_app_runtime', 'dsh_service_runtime']))
    expect(ctx.get('platformHttpController')).toBeUndefined()
  })

  it('runs a worker with only its worker pool and removes its health server on unload', async () => {
    const ctx = await boot('worker')
    expect(external.roles).toEqual(['dsh_worker_runtime'])
    expect(ctx.get('webServer')).toBeDefined()
    expect(ctx.get('platformHttpController')).toBeUndefined()
    expect((await fetch(`http://127.0.0.1:${ctx.webServer.port}/health/ready`)).status).toBe(200)
    await ctx.fiber.dispose()
    expect(external.closed).toContain('lock')
    expect(external.closed).toContain('dsh_worker_runtime')
    expect(ctx.get('webServer')).toBeUndefined()
  })

  it('delivers an in-flight HTTP response before Loader disposal closes its transport and pools', async () => {
    const ctx = await boot('api')
    let release!: () => void
    external.queryGate = new Promise<void>((resolve) => { release = resolve })
    const pending = fetch(`http://127.0.0.1:${ctx.webServer.port}/health/ready`).then(async response => ({
      status: response.status, body: await response.text(),
    }))
    const observed = expect(pending).resolves.toEqual({ status: 503, body: '{"ready":false}' })
    await vi.waitFor(() => { expect(external.queryStarted).toBe(true) })
    const closing = ctx.fiber.dispose()
    await Promise.resolve()
    expect(external.closed).toEqual([])
    release()
    await observed
    await closing
    expect(external.closed).toContain('dsh_app_runtime')
    expect(ctx.get('webServer')).toBeUndefined()
  })
})
