import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthHttpRequest, AuthHttpResponse } from '@deepseek-ai/dsh-user-auth'
import { apply, type Config, type PlatformHttpControllerLike } from '../src/index.ts'

interface CapturedResponse {
  statusCode: number
  headers: Map<string, string | string[]>
  body: string
}

interface RegisteredRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

function requestOf(input: {
  method: string
  url: string
  body?: string
  headers?: Record<string, string>
  remoteAddress?: string
}): IncomingMessage {
  const stream = Readable.from(input.body === undefined ? [] : [Buffer.from(input.body)]) as unknown as IncomingMessage
  Object.assign(stream, {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress },
  })
  return stream
}

function responseOf(): { response: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, headers: new Map(), body: '' }
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]): void {
      captured.headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : String(value))
    },
    end(body?: string | Buffer): void {
      captured.statusCode = response.statusCode
      captured.body = body === undefined ? '' : String(body)
    },
    writeHead(status: number, headers?: Record<string, string>): void {
      response.statusCode = status
      captured.statusCode = status
      for (const [name, value] of Object.entries(headers ?? {})) response.setHeader(name, value)
    },
  } as unknown as ServerResponse
  return { response, captured }
}

function install(controller: PlatformHttpControllerLike, config: Config = { maxBodyBytes: 64 }): RegisteredRoute {
  const routes: RegisteredRoute[] = []
  const webServer = {
    register(route: RegisteredRoute): () => void {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  }
  const context = {
    webServer,
    get(name: string): unknown {
      if (name === 'platformHttpController') return controller
      return undefined
    },
    effect(effect: () => unknown): unknown { return effect() },
  } as unknown as Context
  apply(context, config)
  const route = routes.find(candidate => candidate.kind === 'prefix' && candidate.path === '/api')
  if (route === undefined) throw new Error('adapter did not register /api route')
  return route
}

describe('Platform HTTP WebServer adapter', () => {
  it('maps a bounded JSON request and server-derived peer address to the controller', async () => {
    const seen: AuthHttpRequest[] = []
    const controller: PlatformHttpControllerLike = {
      handle: async (request) => {
        seen.push(request)
        return { status: 201, headers: { 'x-result': 'created' }, body: '{"ok":true}' }
      },
    }
    const route = install(controller)
    const { response, captured } = responseOf()

    await route.handler(requestOf({
      method: 'POST',
      url: '/api/auth/login?next=%2F',
      body: '{"email":"writer@example.com"}',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token',
        'x-forwarded-for': '198.51.100.2',
      },
      remoteAddress: '127.0.0.1',
    }), response)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'writer@example.com' },
      remoteAddress: '127.0.0.1',
      headers: { authorization: 'Bearer token', 'x-forwarded-for': '198.51.100.2' },
    })
    expect(captured.statusCode).toBe(201)
    expect(captured.headers.get('x-result')).toBe('created')
    expect(captured.body).toBe('{"ok":true}')
  })

  it('rejects malformed JSON before invoking the controller', async () => {
    let called = false
    const controller: PlatformHttpControllerLike = {
      handle: async (_request): Promise<AuthHttpResponse> => {
        called = true
        return { status: 200, headers: {}, body: '{}' }
      },
    }
    const route = install(controller)
    const { response, captured } = responseOf()

    await route.handler(requestOf({
      method: 'POST', url: '/api/auth/login', body: '{not-json',
      headers: { 'content-type': 'application/json' }, remoteAddress: '127.0.0.1',
    }), response)

    expect(called).toBe(false)
    expect(captured.statusCode).toBe(400)
    expect(captured.body).toBe('{"error":"invalid_request"}')
  })

  it('rejects oversized request bodies with 413 while draining the stream', async () => {
    let called = false
    const controller: PlatformHttpControllerLike = {
      handle: async (_request): Promise<AuthHttpResponse> => {
        called = true
        return { status: 200, headers: {}, body: '{}' }
      },
    }
    const route = install(controller, { maxBodyBytes: 4 })
    const { response, captured } = responseOf()

    await route.handler(requestOf({
      method: 'POST', url: '/api/auth/login', body: '{"too-large":true}',
      headers: { 'content-type': 'application/json' }, remoteAddress: '127.0.0.1',
    }), response)

    expect(called).toBe(false)
    expect(captured.statusCode).toBe(413)
    expect(captured.body).toBe('{"error":"payload_too_large"}')
  })
})
