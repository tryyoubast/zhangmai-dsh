import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StagingHttpClient } from '../deploy/local-test/http-client.ts'

const execute = promisify(execFile)
let directory: string
let server: Server
let origin: string
let ca: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-staging-tls-'))
  const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl'
  await execute(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
  ca = await readFile(join(directory, 'cert.pem'), 'utf8')
  server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: ca }, (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/login') {
      response.setHeader('set-cookie', '__Host-dsh_session=test-session; Secure; HttpOnly; SameSite=Lax; Path=/')
    }
    response.end(JSON.stringify({ cookie: request.headers.cookie ?? null, origin: request.headers.origin ?? null }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTPS fixture did not bind a port')
  origin = `https://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  if (server !== undefined) {
    const closed = new Promise<void>((settle) => { server.close(() => { settle() }) })
    server.closeAllConnections()
    await closed
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

describe('local acceptance HTTPS transport', () => {
  it('trusts only the explicit CA and sends the Secure host cookie through its jar', async () => {
    const client = new StagingHttpClient(origin, ca)
    expect((await client.request('/login', { method: 'POST', body: { email: 'user@test.invalid' } })).status).toBe(200)
    const response = await client.request('/me')
    expect(response.body).toEqual({ cookie: '__Host-dsh_session=test-session', origin })
    const [cookie] = await client.jar.getCookies(origin)
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax', hostOnly: true, path: '/' })
  })

  it('rejects an untrusted certificate without changing global TLS settings', async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await expect(new StagingHttpClient(origin, '').request('/me')).rejects.toThrow()
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before)
  })

  it('refuses to send credentials to another origin', async () => {
    await expect(new StagingHttpClient(origin, ca).request('https://example.com/api/auth/me')).rejects.toThrow('origin')
  })
})
