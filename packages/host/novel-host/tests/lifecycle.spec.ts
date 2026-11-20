import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthHttpRequest, AuthHttpResponse } from '@deepseek-ai/dsh-user-auth'
import type { ConsumerOperations } from '../src/queue.ts'
import { apply } from '../src/index.ts'
import { config } from './config-fixture.ts'

const runtime = vi.hoisted(() => ({
  acquired: [] as string[], closed: [] as string[], redis: undefined as EventEmitter | undefined,
  pools: [] as EventEmitter[], probes: [] as string[], probeGate: undefined as Promise<void> | undefined,
  connection: undefined as EventEmitter | undefined, locked: true, connectable: true,
  failAt: '', cleanupFailure: false, stopFailure: false, lockLost: undefined as AbortSignal | undefined,
  consumer: undefined as ConsumerOperations | undefined,
  request: vi.fn< (input: AuthHttpRequest) => Promise<AuthHttpResponse>>(),
  deliver: vi.fn(async () => 'ack' as const), stop: vi.fn(async () => {}),
}))
vi.mock('../src/runtime.ts', () => ({
  readSecret: async () => 'test-only',
  openDatabase: async (_config: unknown, kind: string) => {
    runtime.acquired.push(kind)
    if (runtime.failAt === 'database') throw new Error('password=private')
    const pool = Object.assign(new EventEmitter(), { connect: runtime.connectable ? async () => {
      const connection = Object.assign(new EventEmitter(), {
        query: async () => ({ rows: [{ locked: runtime.locked }] }),
        release: () => { runtime.closed.push('lock') },
      })
      runtime.connection = connection
      return connection
    } : undefined })
    runtime.pools.push(pool)
    return {
      close: async () => { runtime.closed.push(kind); if (runtime.cleanupFailure) throw new Error('private close error') },
      pool,
    }
  },
  checkDatabase: async () => { runtime.probes.push('database'); await runtime.probeGate },
  createApiController: async () => ({ handle: runtime.request }),
  safeController: (controller: unknown) => controller,
  createWorkerDelivery: () => runtime.deliver,
  createProvider: async (_config: unknown, signal: AbortSignal) => { runtime.lockLost = signal; return {} },
}))
vi.mock('../src/queue.ts', () => ({ SerialGenerationConsumer: class {
  constructor(operations: ConsumerOperations) { runtime.consumer = operations }
  start() {}
  async stop() { await runtime.stop(); if (runtime.stopFailure) { runtime.stopFailure = false; throw new Error('stop failed') } }
} }))
vi.mock('../src/broker.ts', () => ({ ensureGroup: async () => {}, brokerIntake: () => ({}) }))
vi.mock('ioredis', () => ({ Redis: class extends EventEmitter {
  constructor(options: { retryStrategy(): number }) { super(); runtime.redis = this; expect(options.retryStrategy()).toBe(10) }
  async connect() { if (runtime.failAt === 'Redis') throw new Error('redis private error') }
  async ping() { runtime.probes.push('redis'); await runtime.probeGate }
  disconnect() { runtime.closed.push('redis') }
} }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({
  verify: async () => {
    runtime.probes.push('smtp'); await runtime.probeGate
    if (runtime.failAt === 'SMTP') throw new Error('smtp private error')
    return true
  },
  close: () => { runtime.closed.push('smtp') },
}) } }))

type Handler = (request: { method: string }, response: {
  writeHead(status: number, headers?: object): void
  end(body?: string): void
}) => Promise<void>
function harness(missingServer = false) {
  let close: (() => Promise<void>) | undefined
  let controller: { handle(input: AuthHttpRequest): Promise<AuthHttpResponse> } | undefined
  const handlers = new Map<string, Handler>()
  const logger = { warn: vi.fn() }
  type Disposer = () => void | Promise<void>
  const ctx = {
    logger,
    effect: (initialize: () => Promise<Disposer> | Generator<Disposer>) => {
      const result = initialize()
      if (Symbol.iterator in result) {
        const disposers = [...result]
        return async () => { for (const dispose of disposers.reverse()) await dispose() }
      }
      return result.then((dispose) => { close = async () => { await dispose() } })
    },
    provide: (_name: string, value: typeof controller) => { controller = value; return () => {} },
    plugin: () => Object.assign(Promise.resolve(), { dispose: async () => {} }),
    get: () => missingServer ? undefined : ({ register: ({ path, handler }: { path: string; handler: Handler }) => {
      handlers.set(path, handler)
      return () => { handlers.delete(path) }
    } }),
  }
  return {
    ctx: ctx as unknown as Context, logger,
    close: async () => { await close?.() },
    handle: (request: AuthHttpRequest) => controller!.handle(request),
    health: async (path: string, method = 'GET') => {
      const response = { writeHead: vi.fn(), end: vi.fn() }
      await handlers.get(path)!({ method }, response)
      return response
    },
  }
}
afterEach(() => {
  runtime.acquired = []; runtime.closed = []; runtime.failAt = ''; runtime.cleanupFailure = false
  runtime.pools = []; runtime.probes = []; runtime.probeGate = undefined
  runtime.stopFailure = false; runtime.connectable = true; runtime.locked = true
  runtime.lockLost = undefined
  runtime.request.mockReset(); runtime.deliver.mockClear(); runtime.stop.mockReset().mockResolvedValue()
})

describe('novel host resource ownership', () => {
  it('rejects a Redis timeout that cannot contain its blocking command', async () => {
    const h = harness(), settings = config('unused')
    const invalid = Object.assign({}, settings, { redis: Object.assign({}, settings.redis, { commandTimeoutMs: settings.redis.blockMs }) })
    await expect(apply(h.ctx, invalid)).rejects.toThrow('must exceed')
    expect(runtime.acquired).toEqual([])
  })

  it('rolls back when the HTTP service fails to become available', async () => {
    const h = harness(true)
    await expect(apply(h.ctx, config('unused'))).rejects.toThrow('HTTP initialization failed')
    expect(runtime.closed).toContain('auth')
  })

  it.each(['database', 'Redis', 'SMTP'])('rolls back acquired clients after %s startup failure without leaking details', async (phase) => {
    const h = harness()
    runtime.failAt = phase
    await expect(apply(h.ctx, config('unused'))).rejects.toThrow(`novel-host: ${phase} initialization failed; check restricted roles, schema, secrets, and endpoints`)
    if (phase !== 'database') expect(runtime.closed).toEqual(expect.arrayContaining(['auth', 'app', 'service', 'redis']))
    if (phase === 'SMTP') expect(runtime.closed[0]).toBe('smtp')
  })

  it('waits for rejected in-flight requests before closing pools and rejects intake during shutdown', async () => {
    const h = harness()
    let reject!: (error: Error) => void
    runtime.request.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    await apply(h.ctx, config('unused'))
    const pending = h.handle({ method: 'GET', path: '/api/workspaces', headers: {} })
    await Promise.resolve()
    const observed = expect(pending).rejects.toThrow('request failed')
    const closing = h.close()
    expect(runtime.closed).toEqual([])
    expect((await h.handle({ method: 'GET', path: '/api/workspaces', headers: {} })).status).toBe(503)
    expect((await h.health('/health/live')).writeHead).toHaveBeenCalledWith(503, expect.any(Object))
    expect((await h.health('/health/ready')).writeHead).toHaveBeenCalledWith(503, expect.any(Object))
    reject(new Error('request failed'))
    await observed
    await closing
    expect(runtime.closed).toContain('auth')
  })

  it('contains cleanup failures and redacts Redis connection events', async () => {
    const h = harness()
    await apply(h.ctx, config('unused'))
    runtime.redis!.emit('error', new Error('redis-password'))
    runtime.cleanupFailure = true
    await h.close()
    expect(runtime.closed).toEqual(['smtp', 'redis', 'service', 'app', 'auth'])
    expect(h.logger.warn).toHaveBeenCalledWith('novel-host: resource cleanup failed')
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('redis-password')
  })

  it('contains idle database pool errors without exposing credentials and removes listeners after close', async () => {
    const h = harness()
    await apply(h.ctx, config('unused'))
    expect(runtime.pools).toHaveLength(3)
    for (const pool of runtime.pools) {
      expect(() => { pool.emit('error', new Error('password=private-database-secret')) }).not.toThrow()
      expect(pool.listenerCount('error')).toBe(1)
    }
    expect(h.logger.warn).toHaveBeenCalledWith('novel-host: database unavailable')
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('private-database-secret')
    await h.close()
    expect(runtime.pools.map(pool => pool.listenerCount('error'))).toEqual([0, 0, 0])
  })

  it('rejects readiness during shutdown without starting a probe after the drain snapshot', async () => {
    const h = harness()
    let finishRequest!: (value: AuthHttpResponse) => void
    let finishProbe!: () => void
    runtime.request.mockReturnValue(new Promise((resolve) => { finishRequest = resolve }))
    await apply(h.ctx, config('unused'))
    const request = h.handle({ method: 'GET', path: '/api/workspaces', headers: {} })
    await Promise.resolve()
    const closing = h.close()
    await setImmediate()
    runtime.probes = []
    runtime.probeGate = new Promise<void>((resolve) => { finishProbe = resolve })
    let lateResponse: Awaited<ReturnType<typeof h.health>> | undefined
    const late = h.health('/health/ready').then((response) => { lateResponse = response })
    try {
      await setImmediate()
      expect(runtime.probes).toEqual([])
      expect(lateResponse?.writeHead).toHaveBeenCalledWith(503, expect.any(Object))
      expect(lateResponse?.end).toHaveBeenCalledWith('{"ready":false}')
    } finally {
      finishRequest({ status: 200, headers: {}, body: '{}' })
      finishProbe()
      await Promise.all([request, late, closing])
    }
    expect(runtime.closed).toContain('auth')
  })

  it.each([false, true])('requires an available ownership connection and exclusive database lock: %s', async (connectable) => {
    const h = harness()
    runtime.connectable = connectable
    runtime.locked = false
    await expect(apply(h.ctx, config('unused', 'worker'))).rejects.toThrow('worker initialization failed')
    expect(runtime.closed).toContain('worker')
    expect(runtime.lockLost).not.toBeDefined()
  })

  it('holds worker resources until delivery stop settles and aborts on ownership loss', async () => {
    const h = harness()
    await apply(h.ctx, config('unused', 'worker'))
    expect(await runtime.consumer!.deliver(['locator'])).toBe('ack')
    expect(runtime.deliver).toHaveBeenCalledWith(['locator'])
    await runtime.consumer!.pause()
    expect((await h.health('/health/ready', 'POST')).writeHead).toHaveBeenCalledWith(405)
    runtime.stopFailure = true
    runtime.connection!.emit('error', new Error('postgres password'))
    await vi.waitFor(() => { expect(h.logger.warn).toHaveBeenCalledWith('novel-host: worker shutdown failed') })
    expect(runtime.lockLost!.aborted).toBe(true)
    expect(await runtime.consumer!.deliver(['locator'])).toBe('retain')
    expect((await h.health('/health/ready')).writeHead).toHaveBeenCalledWith(503, expect.any(Object))
    await expect(runtime.consumer!.pause()).rejects.toThrow()
    let release!: () => void
    runtime.stop.mockReturnValue(new Promise<void>((resolve) => { release = resolve }))
    const closing = h.close()
    expect(runtime.closed).toEqual([])
    release()
    await closing
    expect(runtime.closed).toEqual(['lock', 'smtp', 'redis', 'worker'])
    expect(runtime.connection!.listenerCount('error')).toBe(0)
  })
})
