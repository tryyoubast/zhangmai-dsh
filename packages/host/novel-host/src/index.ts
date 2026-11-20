/** The profile-owned API/worker host. One effect owns intake, in-flight work, and all external clients. */
import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthoringHttp from '@deepseek-ai/dsh-api-novel-authoring-http'
import type { AuthHttpRequest, AuthHttpResponse } from '@deepseek-ai/dsh-user-auth'
import type { DatabaseClient, DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import { Redis } from 'ioredis'
import nodemailer from 'nodemailer'
import { Config } from './config.ts'
import { brokerIntake, ensureGroup } from './broker.ts'
import { checkReadiness } from './boundaries.ts'
import { SerialGenerationConsumer } from './queue.ts'
import { checkDatabase, createApiController, createProvider, createWorkerDelivery, openDatabase, readSecret, safeController } from './runtime.ts'

export { Config }
/** Cordis function-plugin name. */
export const name = 'novel-host'

/**
 * Initialize one bounded novel application through its dsh profile.
 * Startup failures are redacted; disposal stops intake and joins requests/deliveries before closing clients and pools.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.redis.commandTimeoutMs <= config.redis.blockMs) throw new Error('novel-host: Redis command timeout must exceed blocking-read time')
  await ctx.effect(async () => {
    const closers: Array<() => void | Promise<void>> = []
    const active = new Set<Promise<unknown>>()
    const ownership = new AbortController()
    const waiting = new AbortController()
    let accepting = true
    let ownsWorker = false
    let consumer: SerialGenerationConsumer | undefined
    let removeController: (() => void) | undefined
    let phase = 'database'
    const isAccepting = (): boolean => accepting
    const hasOwnership = (): boolean => ownsWorker
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      const task = Promise.resolve().then(work)
      active.add(task)
      void task.finally(() => { active.delete(task) }).catch(() => {})
      return task
    }
    const close = async (): Promise<void> => {
      accepting = false
      waiting.abort()
      await consumer?.stop()
      await Promise.allSettled([...active])
      for (const closer of closers.reverse()) {
        try { await closer() } catch { ctx.logger.warn('novel-host: resource cleanup failed') }
      }
    }
    try {
      const databases = new Map<'auth' | 'app' | 'service' | 'worker', DatabaseClient<DshDatabase>>()
      const acquire = async (kind: 'auth' | 'app' | 'service' | 'worker'): Promise<DatabaseClient<DshDatabase>> => {
        const database = await openDatabase(config, kind)
        databases.set(kind, database)
        // The database provider returns pg.Pool; its driver-neutral type omits events.
        const poolEvents = database.pool as typeof database.pool & Pick<EventEmitter, 'on' | 'off'>
        const unavailable = (): void => { ctx.logger.warn('novel-host: database unavailable') }
        poolEvents.on('error', unavailable)
        closers.push(async () => {
          try { await database.close() } finally { poolEvents.off('error', unavailable) }
        })
        await checkDatabase(database, `dsh_${kind}_runtime`)
        return database
      }
      const pools = config.mode === 'api'
        ? { mode: 'api' as const, auth: await acquire('auth'), app: await acquire('app'), service: await acquire('service') }
        : { mode: 'worker' as const, worker: await acquire('worker') }
      phase = 'Redis'
      const redis = new Redis({
        host: config.redis.host, port: config.redis.port,
        password: await readSecret(config.secretDirectory, 'redis-password'),
        lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
        commandTimeout: config.redis.commandTimeoutMs, connectTimeout: config.redis.connectTimeoutMs,
        retryStrategy: () => config.redis.retryMs,
      })
      redis.on('error', () => { ctx.logger.warn('novel-host: Redis unavailable') })
      closers.push(() => { redis.disconnect() })
      await redis.connect()
      phase = 'SMTP'
      const mail = nodemailer.createTransport({
        host: config.smtp.host, port: config.smtp.port, secure: false,
        connectionTimeout: config.smtp.timeoutMs, greetingTimeout: config.smtp.timeoutMs, socketTimeout: config.smtp.timeoutMs,
        logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
      })
      closers.push(() => { mail.close() })
      await mail.verify()

      if (pools.mode === 'api') {
        phase = 'authentication'
        const controller = safeController(await createApiController(config, pools, redis, mail))
        removeController = ctx.provide('platformHttpController', {
          handle(request: AuthHttpRequest): Promise<AuthHttpResponse> {
            if (!accepting) return Promise.resolve({ status: 503, headers: {}, body: '{"error":"service_unavailable"}' })
            return track(() => controller.handle(request))
          },
        })
      } else {
        phase = 'worker'
        const database = pools.worker
        const connection = await database.pool.connect?.()
        if (connection === undefined) throw new Error('novel-host: worker ownership connection unavailable')
        const events = connection as typeof connection & {
          on?: (event: 'error', listener: () => void) => void
          off?: (event: 'error', listener: () => void) => void
        }
        const lostOwnership = (): void => {
          ownsWorker = false
          ownership.abort()
          waiting.abort()
          void consumer?.stop().catch(() => { ctx.logger.warn('novel-host: worker shutdown failed') })
          ctx.logger.warn('novel-host: worker ownership connection unavailable')
        }
        events.on?.('error', lostOwnership)
        closers.push(async () => {
          try { await connection.query("SELECT pg_advisory_unlock(hashtextextended('dsh:novel:generation-worker', 0))") }
          finally {
            ownsWorker = false
            connection.release()
            events.off?.('error', lostOwnership)
          }
        })
        const result = await connection.query("SELECT pg_try_advisory_lock(hashtextextended('dsh:novel:generation-worker', 0)) AS locked") as { rows: Array<{ locked: boolean }> }
        if (result.rows[0]?.locked !== true) throw new Error('novel-host: another generation worker is active')
        ownsWorker = true
        await ensureGroup(redis, config.redis)
        const deliver = createWorkerDelivery(database, await createProvider(config, ownership.signal))
        consumer = new SerialGenerationConsumer({
          ...brokerIntake(redis, config.redis, `novel-worker-${randomUUID()}`),
          deliver: fields => ownsWorker ? deliver(fields) : Promise.resolve('retain'),
          pause: async () => { await delay(config.redis.retryMs, undefined, { signal: waiting.signal }) },
        })
        consumer.start()
      }
      phase = 'HTTP'
      const web = ctx.plugin(WebServer, { host: config.server.host, port: config.server.port })
      await web
      const webServer = ctx.get('webServer')
      if (webServer === undefined) throw new Error('novel-host: HTTP server unavailable')
      let http: ReturnType<typeof ctx.plugin> | undefined
      if (config.mode === 'api') {
        http = ctx.plugin(AuthoringHttp, { maxBodyBytes: config.server.maxBodyBytes })
        await http
      }
      for (const path of ['/health/live', '/health/ready'] as const) {
        closers.push(webServer.register({
          kind: 'exact', path,
          handler: async (request, response) => {
            if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
            const status = !accepting || path === '/health/live' ? { ready: accepting } : await track(() => checkReadiness({
              database: async () => {
                for (const [kind, database] of databases) await checkDatabase(database, `dsh_${kind}_runtime`)
                if (!isAccepting() || config.mode === 'worker' && !hasOwnership()) throw new Error('unavailable')
              },
              redis: async () => { await redis.ping() },
              smtp: async () => { await mail.verify() },
            }))
            response.writeHead(status.ready ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' })
            response.end(path === '/health/live' ? JSON.stringify({ live: status.ready }) : JSON.stringify(status))
          },
        }))
      }
      // A synchronous generator captures the original child disposers before shutdown.
      return ctx.effect(function* () {
        if (removeController !== undefined) yield removeController
        yield web.dispose
        if (http !== undefined) yield http.dispose
        yield close
      }, 'novel-host ordered shutdown')
    } catch {
      ownership.abort()
      await close()
      throw new Error(`novel-host: ${phase} initialization failed; check restricted roles, schema, secrets, and endpoints`)
    }
  }, 'novel-host runtime')
}
