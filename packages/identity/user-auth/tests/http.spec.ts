import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  AuthHttpController,
  AuthSecurityControls,
  RefreshTokenService,
  UserAuthService,
  createAccessToken,
  hashToken,
  resolveAuthPrincipal,
  verifyAccessToken,
  type AuthHttpRequest,
  type AuthHttpSession,
  type AuthHttpSessionResolver,
  type AuthLifecycleStore,
  type AuthUserRecord,
  type RefreshTokenReplacement,
  type RefreshTokenRecord,
  type RefreshTokenRotationResult,
  type RefreshTokenStore,
} from '../src/index.ts'

class HttpStore implements AuthLifecycleStore, RefreshTokenStore {
  readonly users = new Map<string, AuthUserRecord>()
  readonly sessions = new Map<string, { userId: string; tokenHash: string }>()
  readonly verification = new Map<string, { userId: string; expiresAt: Date; consumedAt: Date | null }>()
  readonly resets = new Map<string, { userId: string; expiresAt: Date; consumedAt: Date | null }>()
  readonly refresh = new Map<string, RefreshTokenRecord>()

  findUserByEmail(emailNormalized: string): Promise<AuthUserRecord | null> {
    return Promise.resolve([...this.users.values()].find(user => user.emailNormalized === emailNormalized) ?? null)
  }
  insertPendingUser(user: Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>): Promise<void> {
    this.users.set(user.id, { ...user, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: null })
    return Promise.resolve()
  }
  createEmailVerificationToken(userId: string, tokenHashValue: string, expiresAt: Date): Promise<void> {
    this.verification.set(tokenHashValue, { userId, expiresAt, consumedAt: null })
    return Promise.resolve()
  }
  recordFailedLogin(userId: string, now: Date, threshold: number, lockDurationMs: number): Promise<void> {
    const user = this.users.get(userId)
    if (user === undefined) throw new Error('user missing')
    const failedLoginCount = user.failedLoginCount + 1
    this.users.set(userId, {
      ...user,
      failedLoginCount,
      lockedUntil: failedLoginCount >= threshold ? new Date(now.getTime() + lockDurationMs) : null,
    })
    return Promise.resolve()
  }
  recordSuccessfulLogin(userId: string): Promise<void> {
    const user = this.users.get(userId)
    if (user === undefined) throw new Error('user missing')
    this.users.set(userId, { ...user, failedLoginCount: 0, lockedUntil: null })
    return Promise.resolve()
  }
  createSession(input: { userId: string; tokenHash: string }): Promise<{ id: string }> {
    const id = `session-${String(this.sessions.size + 1)}`
    this.sessions.set(id, { userId: input.userId, tokenHash: input.tokenHash })
    return Promise.resolve({ id })
  }
  async consumeAndActivateEmailVerification(tokenHashValue: string, now: Date): Promise<boolean> {
    const token = this.verification.get(tokenHashValue)
    if (token === undefined || token.consumedAt !== null || token.expiresAt <= now) return false
    const user = this.users.get(token.userId)
    if (user === undefined) throw new Error('user missing')
    token.consumedAt = now
    this.users.set(token.userId, { ...user, status: 'active', emailVerifiedAt: now })
    return true
  }
  createPasswordResetToken(userId: string, tokenHashValue: string, expiresAt: Date): Promise<void> {
    this.resets.set(tokenHashValue, { userId, expiresAt, consumedAt: null })
    return Promise.resolve()
  }
  consumePasswordResetToken(tokenHashValue: string, now: Date): Promise<string | null> {
    const token = this.resets.get(tokenHashValue)
    if (token === undefined || token.consumedAt !== null || token.expiresAt <= now) return Promise.resolve(null)
    token.consumedAt = now
    return Promise.resolve(token.userId)
  }
  updatePassword(userId: string, passwordHash: string, now: Date): Promise<void> {
    const user = this.users.get(userId)
    if (user === undefined) throw new Error('user missing')
    this.users.set(userId, { ...user, passwordHash, passwordChangedAt: now })
    return Promise.resolve()
  }
  revokeUserSessions(userId: string): Promise<void> {
    for (const [id, session] of this.sessions) if (session.userId === userId) this.sessions.delete(id)
    return Promise.resolve()
  }
  create(record: RefreshTokenRecord): Promise<void> {
    this.refresh.set(record.tokenHash, record)
    return Promise.resolve()
  }
  rotate(tokenHashValue: string, replacement: RefreshTokenReplacement, now: Date): Promise<RefreshTokenRotationResult> {
    const current = this.refresh.get(tokenHashValue)
    if (current === undefined || current.revokedAt !== null || current.expiresAt <= now) {
      return Promise.resolve({ status: 'invalid' })
    }
    if (current.usedAt !== null) {
      for (const [hash, record] of this.refresh) {
        if (record.familyId === current.familyId) this.refresh.set(hash, { ...record, revokedAt: now })
      }
      return Promise.resolve({ status: 'reused' })
    }
    this.refresh.set(current.tokenHash, { ...current, usedAt: now })
    this.refresh.set(replacement.tokenHash, {
      ...replacement,
      userId: current.userId,
      sessionId: current.sessionId,
      familyId: current.familyId,
      usedAt: null,
      revokedAt: null,
    })
    return Promise.resolve({
      status: 'rotated',
      id: replacement.id,
      userId: current.userId,
      sessionId: current.sessionId,
      familyId: current.familyId,
    })
  }
  revokeFamily(familyId: string): Promise<void> {
    for (const [hash, record] of this.refresh) {
      if (record.familyId === familyId) this.refresh.set(hash, { ...record, revokedAt: new Date() })
    }
    return Promise.resolve()
  }
}

function body(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

describe('authentication HTTP controller', () => {
  describe.each([
    { route: 'register', method: 'POST', operation: 'register', body: { email: 'writer@example.com', password: 'a sufficiently long password' } },
    { route: 'verify-email', method: 'POST', operation: 'verifyEmail', body: { token: 'verification-token' } },
    { route: 'login', method: 'POST', operation: 'login', body: { email: 'writer@example.com', password: 'a sufficiently long password' } },
    { route: 'forgot-password', method: 'POST', operation: 'issuePasswordReset', body: { email: 'writer@example.com' } },
    { route: 'reset-password', method: 'POST', operation: 'resetPassword', body: { token: 'reset-token', password: 'a sufficiently long password' } },
    { route: 'logout', method: 'POST', operation: 'revokeSession', body: {} },
    { route: 'refresh', method: 'POST', operation: 'rotate', body: { refreshToken: 'refresh-token' } },
    { route: 'me', method: 'GET', operation: 'resolveIdentity', body: {} },
  ] as const)('$route asynchronous failures', ({ route, method, operation, body: requestBody }) => {
    it.each([
      { message: 'password validation secret detail', status: 400, error: 'invalid_request' },
      { message: 'email address validation secret detail', status: 400, error: 'invalid_request' },
      { message: 'origin validation secret detail', status: 400, error: 'invalid_request' },
      { message: 'backend connection secret detail', status: 500, error: 'authentication_unavailable' },
    ])('returns $status without leaking $message', async ({ message, status, error }) => {
      const store = new HttpStore()
      const auth = new UserAuthService(store)
      const refreshTokens = new RefreshTokenService(store)
      const failure = new Error(message)
      const session: AuthHttpSession = {
        userId: 'user-1', sessionId: 'session-1', clientType: 'browser',
        expiresAt: new Date('2099-01-01T00:00:00Z'), revokedAt: null,
      }
      const sessionResolver: AuthHttpSessionResolver = {
        findSessionByTokenHash: async tokenHash => tokenHash === hashToken('session-token') ? session : null,
        findSessionById: async () => ({ ...session, clientType: 'official-client' }),
        revokeSession: async () => undefined,
      }
      const options = {
        sessionResolver,
        resolveIdentity: async (userId: string) => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] as const }),
      }
      if (operation === 'rotate') vi.spyOn(refreshTokens, operation).mockRejectedValue(failure)
      else if (operation === 'revokeSession') vi.spyOn(sessionResolver, operation).mockRejectedValue(failure)
      else if (operation === 'resolveIdentity') vi.spyOn(options, operation).mockRejectedValue(failure)
      else vi.spyOn(auth, operation).mockRejectedValue(failure)
      const controller = new AuthHttpController(auth, refreshTokens, options)
      const request: AuthHttpRequest = {
        method, path: `/api/auth/${route}`, headers: { cookie: '__Host-dsh_session=session-token' }, body: requestBody,
      }
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      try {
        await expect(controller.handle(request)).resolves.toEqual({
          status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error }),
        })
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })
  })

  it('refreshes an official-client session through an instance-backed session resolver', async () => {
    class SessionResolver implements AuthHttpSessionResolver {
      readonly sessions = new Map<string, AuthHttpSession>([['session-1', {
        userId: 'user-1', sessionId: 'session-1', clientType: 'official-client',
        expiresAt: new Date('2099-01-01T00:00:00Z'), revokedAt: null,
      }]])

      findSessionById(sessionId: string): Promise<AuthHttpSession | null> {
        return Promise.resolve(this.sessions.get(sessionId) ?? null)
      }
      findSessionByTokenHash(): Promise<null> { return Promise.resolve(null) }
      revokeSession(sessionId: string): Promise<void> {
        this.sessions.delete(sessionId)
        return Promise.resolve()
      }
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = new Date()
    const store = new HttpStore()
    const refreshTokens = new RefreshTokenService(store, () => now)
    const issued = await refreshTokens.issue('user-1', 'session-1')
    const controller = new AuthHttpController(new UserAuthService(store), refreshTokens, {
      now: () => now,
      accessToken: { privateKey, publicKey, issuer: 'dsh', audience: 'dsh-api' },
      sessionResolver: new SessionResolver(),
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
    })

    const response = await controller.handle({
      method: 'POST', path: '/api/auth/refresh', headers: {}, body: { refreshToken: issued.token },
    })

    expect(response.status).toBe(200)
    const result = body(response)
    expect(result.tokenType).toBe('Bearer')
    expect(result.refreshToken).not.toBe(issued.token)
    if (typeof result.accessToken !== 'string' || typeof result.refreshToken !== 'string') throw new Error('credentials missing')
    const replacementToken = result.refreshToken
    expect(verifyAccessToken(result.accessToken, { publicKey, issuer: 'dsh', audience: 'dsh-api', now: now.getTime() }))
      .toMatchObject({ sub: 'user-1', sid: 'session-1' })
    expect([...store.refresh.values()].find(record => record.tokenHash === hashToken(replacementToken)))
      .toMatchObject({ userId: 'user-1', sessionId: 'session-1' })
  })

  it('resolves a browser principal from a hashed __Host session cookie', async () => {
    const store = new HttpStore()
    const auth = new UserAuthService(store)
    const registration = await auth.register('writer@example.com', 'a sufficiently long password')
    await auth.verifyEmail(registration.verificationToken)
    const login = await auth.login('writer@example.com', 'a sufficiently long password', 'browser')
    if (login === null) throw new Error('login failed')
    const principal = await resolveAuthPrincipal({
      headers: { cookie: `__Host-dsh_session=${login.sessionToken}` },
      sessionResolver: {
        findSessionByTokenHash: async (tokenHashValue) => {
          const session = [...store.sessions.entries()].find(([, value]) => value.tokenHash === tokenHashValue)
          return session === undefined ? null : {
            userId: session[1].userId,
            sessionId: session[0],
            clientType: 'browser',
            expiresAt: new Date('2099-01-01T00:00:00Z'),
            revokedAt: null,
          }
        },
      },
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
    })
    expect(principal).toEqual({
      userId: registration.userId,
      sessionId: login.sessionId,
      clientType: 'browser',
      workspaceId: 'workspace-1',
      roles: ['owner'],
      actorType: 'user',
    })
  })

  it('rejects a revoked official-client access token before resolving workspace identity', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const token = createAccessToken({ userId: 'user-1', sessionId: 'session-1', scope: ['workspace:read'] }, {
      privateKey,
      issuer: 'dsh',
      audience: 'dsh-api',
      now: Date.parse('2026-01-01T00:00:00Z'),
    })
    const principal = await resolveAuthPrincipal({
      now: () => new Date('2026-01-01T00:01:00Z'),
      headers: { authorization: `Bearer ${token}` },
      accessToken: { publicKey, issuer: 'dsh', audience: 'dsh-api' },
      sessionResolver: {
        findSessionByTokenHash: async () => null,
        findSessionById: async () => ({
          userId: 'user-1', sessionId: 'session-1', clientType: 'official-client',
          expiresAt: new Date('2099-01-01T00:00:00Z'), revokedAt: new Date('2026-01-01T00:00:30Z'),
        }),
      },
      resolveIdentity: async () => ({ userId: 'user-1', workspaceId: 'workspace-1', roles: ['owner'] }),
    })
    expect(principal).toBeNull()
  })

  it('applies Redis-backed request budgets before creating accounts', async () => {
    const store = new HttpStore()
    const decisions: string[] = []
    const security = new AuthSecurityControls({
      async consume(key) {
        decisions.push(key)
        return false
      },
      async block() { return undefined },
    }, {
      async sendEmailVerification() { return undefined },
      async sendPasswordReset() { return undefined },
    })
    const response = await new AuthHttpController(new UserAuthService(store), store, { security }).handle({
      method: 'POST', path: '/api/auth/register', remoteAddress: '127.0.0.1', headers: {},
      body: { email: 'writer@example.com', password: 'a sufficiently long password' },
    })
    expect(response.status).toBe(429)
    expect(decisions[0]).toMatch(/^auth:register:127\.0\.0\.1:/u)
    expect(store.users.size).toBe(0)
  })

  it('sets a secure __Host- cookie for browser login and never returns the raw cookie in JSON', async () => {
    const store = new HttpStore()
    const auth = new UserAuthService(store)
    const controller = new AuthHttpController(auth, store, {
      now: () => new Date('2026-01-01T00:00:00Z'),
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
    })
    const registration = await auth.register('writer@example.com', 'a sufficiently long password')
    await auth.verifyEmail(registration.verificationToken)
    const response = await controller.handle({
      method: 'POST', path: '/api/auth/login', headers: { origin: 'https://writer.example' },
      body: { email: 'writer@example.com', password: 'a sufficiently long password', clientType: 'browser' },
    })
    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toMatch(/^__Host-dsh_session=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/$/u)
    expect(body(response)).not.toHaveProperty('sessionToken')
  })

  it('returns the same unauthorized response for an unknown account and a bad password', async () => {
    const store = new HttpStore()
    const auth = new UserAuthService(store)
    const controller = new AuthHttpController(auth, store)
    const missing = await controller.handle({ method: 'POST', path: '/api/auth/login', headers: {}, body: { email: 'missing@example.com', password: 'a sufficiently long password' } })
    const registration = await auth.register('writer@example.com', 'a sufficiently long password')
    await auth.verifyEmail(registration.verificationToken)
    const wrong = await controller.handle({ method: 'POST', path: '/api/auth/login', headers: {}, body: { email: 'writer@example.com', password: 'wrong password that is long' } })
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(missing.status)
    expect(wrong.body).toBe(missing.body)
  })

  it('rejects state-changing browser requests from a foreign origin', async () => {
    const controller = new AuthHttpController(new UserAuthService(new HttpStore()), new HttpStore(), { allowedOrigin: 'https://writer.example' })
    const response = await controller.handle({ method: 'POST', path: '/api/auth/logout', headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
  })

  it('only accepts hashed session material when resolving /me', async () => {
    const store = new HttpStore()
    const auth = new UserAuthService(store)
    const controller = new AuthHttpController(auth, store, {
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
      sessionResolver: {
        findSessionByTokenHash: async (tokenHash) => {
          const session = [...store.sessions.values()].find(value => value.tokenHash === tokenHash)
          if (session === undefined) return null
          const sessionId = [...store.sessions.entries()].find(([, value]) => value === session)?.[0]
          if (sessionId === undefined) return null
          return { userId: session.userId, sessionId, clientType: 'browser', expiresAt: new Date('2099-01-01T00:00:00Z'), revokedAt: null }
        },
        revokeSession: async () => undefined,
      },
    })
    const registration = await auth.register('writer@example.com', 'a sufficiently long password')
    await auth.verifyEmail(registration.verificationToken)
    const login = await auth.login('writer@example.com', 'a sufficiently long password', 'browser')
    if (login === null) throw new Error('login failed')
    const response = await controller.handle({
      method: 'GET', path: '/api/auth/me', headers: { cookie: `__Host-dsh_session=${login.sessionToken}` },
    })
    expect(response.status).toBe(200)
    expect(body(response)).toMatchObject({ userId: registration.userId, workspaceId: 'workspace-1' })
    expect(store.sessions.has(login.sessionId)).toBe(true)
  })

  it('revokes the session identified by an official-client access token on logout', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const store = new HttpStore()
    const auth = new UserAuthService(store)
    const registration = await auth.register('client@example.com', 'a sufficiently long password')
    await auth.verifyEmail(registration.verificationToken)
    const login = await auth.login('client@example.com', 'a sufficiently long password', 'official-client')
    if (login === null) throw new Error('login failed')
    const accessToken = createAccessToken({
      userId: registration.userId,
      sessionId: login.sessionId,
      scope: ['workspace:read'],
    }, { privateKey, issuer: 'dsh', audience: 'dsh-api', now: Date.parse('2026-01-01T00:00:00Z') })
    let revokedSession: string | undefined
    const controller = new AuthHttpController(auth, store, {
      now: () => new Date('2026-01-01T00:00:00Z'),
      accessToken: { privateKey, publicKey, issuer: 'dsh', audience: 'dsh-api' },
      sessionResolver: {
        findSessionById: async sessionId => ({
          userId: registration.userId,
          sessionId,
          clientType: 'official-client',
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          revokedAt: null,
        }),
        revokeSession: async (sessionId) => { revokedSession = sessionId },
        findSessionByTokenHash: async () => null,
      },
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
    })

    const response = await controller.handle({
      method: 'POST', path: '/api/auth/logout', headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(response.status).toBe(204)
    expect(revokedSession).toBe(login.sessionId)
  })

  it('resolves /me from a valid official-client access token', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const accessToken = createAccessToken({
      userId: 'user-1',
      sessionId: 'session-1',
      scope: ['workspace:read'],
    }, { privateKey, issuer: 'dsh', audience: 'dsh-api', now: Date.parse('2026-01-01T00:00:00Z') })
    const controller = new AuthHttpController(new UserAuthService(new HttpStore()), new HttpStore(), {
      now: () => new Date('2026-01-01T00:01:00Z'),
      accessToken: { privateKey, publicKey, issuer: 'dsh', audience: 'dsh-api' },
      sessionResolver: {
        findSessionById: async () => ({
          userId: 'user-1', sessionId: 'session-1', clientType: 'official-client',
          expiresAt: new Date('2099-01-01T00:00:00Z'), revokedAt: null,
        }),
        findSessionByTokenHash: async () => null,
        revokeSession: async () => undefined,
      },
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['editor'] }),
    })

    const response = await controller.handle({
      method: 'GET', path: '/api/auth/me', headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(response.status).toBe(200)
    expect(body(response)).toMatchObject({
      userId: 'user-1', sessionId: 'session-1', clientType: 'official-client', workspaceId: 'workspace-1',
    })
  })

  it('rejects refresh tokens whose official-client session was revoked', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = new Date('2026-01-01T00:00:00Z')
    const store = new HttpStore()
    const auth = new UserAuthService(store, { now: () => now })
    const registration = await auth.register('revoked@example.com', 'a sufficiently long password')
    await auth.verifyEmail(registration.verificationToken)
    const controller = new AuthHttpController(auth, store, {
      now: () => now,
      accessToken: { privateKey, publicKey, issuer: 'dsh', audience: 'dsh-api' },
      sessionResolver: {
        findSessionById: async sessionId => ({
          userId: registration.userId, sessionId, clientType: 'official-client',
          expiresAt: new Date('2099-01-01T00:00:00Z'), revokedAt: now,
        }),
        findSessionByTokenHash: async () => null,
        revokeSession: async () => undefined,
      },
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
    })
    const login = await controller.handle({
      method: 'POST', path: '/api/auth/login', headers: {},
      body: { email: 'revoked@example.com', password: 'a sufficiently long password', clientType: 'official-client' },
    })
    const refreshToken = body(login).refreshToken
    if (typeof refreshToken !== 'string') throw new Error('refresh token missing')

    const response = await controller.handle({
      method: 'POST', path: '/api/auth/refresh', headers: {}, body: { refreshToken },
    })

    expect(response.status).toBe(401)
    expect(body(response)).toEqual({ error: 'invalid_refresh_token' })
  })

  it('maps refresh-token replay to the same 401 response without throwing', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = new Date('2026-01-01T00:00:00Z')
    const store = new HttpStore()
    const refresh = await new RefreshTokenService(store, () => now).issue('user-1', 'session-1')
    const controller = new AuthHttpController(new UserAuthService(store), store, {
      now: () => now,
      accessToken: { privateKey, publicKey, issuer: 'dsh', audience: 'dsh-api' },
      sessionResolver: {
        findSessionByTokenHash: async () => null,
        findSessionById: async sessionId => ({
          userId: 'user-1', sessionId, clientType: 'official-client',
          expiresAt: new Date('2099-01-01T00:00:00Z'), revokedAt: null,
        }),
        revokeSession: async () => undefined,
      },
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
    })

    const first = await controller.handle({
      method: 'POST', path: '/api/auth/refresh', headers: {}, body: { refreshToken: refresh.token },
    })
    const replay = await controller.handle({
      method: 'POST', path: '/api/auth/refresh', headers: {}, body: { refreshToken: refresh.token },
    })

    expect(first.status).toBe(200)
    expect(replay.status).toBe(401)
    expect(body(replay)).toEqual({ error: 'invalid_refresh_token' })
  })

  it('fails closed when refresh cannot resolve the owning session', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const now = new Date('2026-01-01T00:00:00Z')
    const store = new HttpStore()
    const refresh = await new RefreshTokenService(store, () => now).issue('user-1', 'session-1')
    const controller = new AuthHttpController(new UserAuthService(store), store, {
      now: () => now,
      accessToken: { privateKey, publicKey, issuer: 'dsh', audience: 'dsh-api' },
      resolveIdentity: async userId => ({ userId, workspaceId: 'workspace-1', roles: ['owner'] }),
    })

    const response = await controller.handle({
      method: 'POST', path: '/api/auth/refresh', headers: {}, body: { refreshToken: refresh.token },
    })

    expect(response.status).toBe(401)
  })
})
