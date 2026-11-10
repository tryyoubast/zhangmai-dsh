import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  AccessTokenInvalidError, AuthHttpController, AuthSecurityControls, AuthTemplateMailProvider,
  InvalidPasswordHashError, PasswordHashingUnavailableError, RefreshTokenService, RedisAuthRateLimiter,
  UserAuthService, canPerform, createAccessToken, resolveAuthPrincipal, verifyAccessToken, verifyPassword,
  type AuthHttpControllerOptions, type AuthHttpIdentity, type AuthHttpSession, type AuthLifecycleStore, type AuthUserRecord,
} from '../src/index.ts'
import { MemoryRefreshTokenStore } from './refresh-memory.ts'

const now = new Date('2026-11-09T00:00:00Z')
const future = new Date(now.getTime() + 600_000)
const keys = generateKeyPairSync('ed25519')
const identity: AuthHttpIdentity = { userId: 'user', workspaceId: 'workspace', roles: ['owner'] }
const session: AuthHttpSession = { userId: 'user', sessionId: 'session', clientType: 'official-client', expiresAt: future, revokedAt: null }
const access = { ...keys, issuer: 'dsh', audience: 'api', now: now.getTime() }
const accessToken = () => createAccessToken({ userId: 'user', sessionId: 'session', scope: [] }, access)

function storeFixture() {
  const find = vi.fn<AuthLifecycleStore['findUserByEmail']>().mockResolvedValue(null)
  const failed = vi.fn<AuthLifecycleStore['recordFailedLogin']>().mockResolvedValue(undefined)
  const register = vi.fn<NonNullable<AuthLifecycleStore['registerPendingUser']>>().mockResolvedValue(undefined)
  const reset = vi.fn<NonNullable<AuthLifecycleStore['resetPassword']>>().mockResolvedValue(undefined)
  const store: AuthLifecycleStore = {
    findUserByEmail: find,
    insertPendingUser: async () => undefined,
    createEmailVerificationToken: async () => undefined,
    registerPendingUser: register,
    recordFailedLogin: failed,
    recordSuccessfulLogin: async () => undefined,
    createSession: async () => ({ id: 'session' }),
    consumeAndActivateEmailVerification: async () => true,
    createPasswordResetToken: async () => undefined,
    consumePasswordResetToken: async () => 'user',
    updatePassword: async () => undefined,
    revokeUserSessions: async () => undefined,
    resetPassword: reset,
  }
  return { store, find, failed, register, reset }
}

function controller(options: AuthHttpControllerOptions = {}) {
  const auth = new UserAuthService(storeFixture().store, { now: () => now })
  const refreshStore = new MemoryRefreshTokenStore()
  return { auth, refreshStore, http: new AuthHttpController(auth, new RefreshTokenService(refreshStore, () => now),
    { now: () => now, ...options }) }
}

function security(allowed = true) {
  const send = vi.fn<NonNullable<AuthHttpControllerOptions['mail']>['sendEmailVerification']>().mockResolvedValue(undefined)
  const reset = vi.fn<NonNullable<AuthHttpControllerOptions['mail']>['sendPasswordReset']>().mockResolvedValue(undefined)
  const mail = { sendEmailVerification: send, sendPasswordReset: reset }
  const controls = new AuthSecurityControls({ consume: async () => allowed, block: async () => undefined }, mail, () => now)
  return { mail, send, reset, controls }
}

describe('additional authentication failure and policy paths', () => {
  it('keeps stable hashing error identities', () => {
    expect(new PasswordHashingUnavailableError()).toMatchObject({ name: 'PasswordHashingUnavailableError',
      code: 'PASSWORD_HASHING_UNAVAILABLE' })
    expect(new InvalidPasswordHashError()).toMatchObject({ name: 'InvalidPasswordHashError', code: 'PASSWORD_HASH_INVALID' })
  })

  it.each(['not-a-phc', '$argon2id$v=19$m=1,t=3,p=1$c2FsdA$ZGlnZXN0', '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$ZGlnZXN0'])(
    'rejects malformed or unsupported stored password material %s', async (encoded) => {
      await expect(verifyPassword('arbitrary password', encoded)).rejects.toBeInstanceOf(InvalidPasswordHashError)
    },
  )

  it('uses the configured pepper for registration, login failures, and atomic password reset', async () => {
    const fixture = storeFixture()
    const pepper = Buffer.from('deployment-owned-pepper')
    const service = new UserAuthService(fixture.store, { now: () => now, pepper, failedLoginThreshold: 3, lockDurationMs: 9000 })
    await service.register('writer@example.test', 'a sufficiently long password')
    const registration = fixture.register.mock.calls[0]
    if (registration === undefined) throw new Error('Registration was not persisted')
    const user: AuthUserRecord = { ...registration[0], status: 'active', emailVerifiedAt: now, failedLoginCount: 0, lockedUntil: null }
    fixture.find.mockResolvedValue({ ...user, lockedUntil: now })
    await expect(service.login(user.email, 'a different long password', 'browser')).resolves.toBeNull()
    expect(fixture.failed).toHaveBeenCalledWith(user.id, now, 3, 9000)
    await expect(service.login(user.email, 'a sufficiently long password', 'browser')).resolves.toMatchObject({ userId: user.id })
    await expect(service.resetPassword('raw-reset', 'a replacement long password')).resolves.toBe(true)
    const reset = fixture.reset.mock.calls[0]
    if (reset === undefined) throw new Error('Password reset was not persisted')
    expect(reset[0]).toBe('user')
    await expect(verifyPassword('a replacement long password', reset[1], { pepper })).resolves.toBe(true)
  })

  it('rejects a store without lifecycle support', async () => {
    const { store } = storeFixture()
    Reflect.deleteProperty(store, 'consumeAndActivateEmailVerification')
    await expect(new UserAuthService(store).verifyEmail('token')).rejects.toThrow('does not implement consumeAndActivateEmailVerification')
  })

  it.each(['disabled', 'deleted'] as const)('does not issue password reset for a %s account', async (status) => {
    const { store, find } = storeFixture()
    find.mockResolvedValue({ id: 'user', email: 'writer@example.test', emailNormalized: 'writer@example.test', passwordHash: '',
      status, emailVerifiedAt: now, failedLoginCount: 0, lockedUntil: null })
    await expect(new UserAuthService(store).issuePasswordReset('writer@example.test')).resolves.toBeNull()
  })

  it('uses wall-clock defaults when issuing refresh tokens and sending reset mail', async () => {
    const start = Date.now()
    const memory = new MemoryRefreshTokenStore()
    const result = await new RefreshTokenService(memory).issue('user', 'session')
    const record = [...memory.records.values()].find(value => value.id === result.id)
    expect(record?.expiresAt.getTime()).toBeGreaterThan(start)
    const mail = security()
    const controls = new AuthSecurityControls({ consume: async () => true, block: async () => undefined }, mail.mail)
    await controls.sendPasswordReset('writer@example.test', 'token')
    const input = mail.reset.mock.calls[0]?.[0]
    expect(input?.expiresAt.getTime()).toBeGreaterThanOrEqual(start + 3_600_000)
    const dispatch = vi.fn().mockResolvedValue(undefined)
    await new AuthTemplateMailProvider({ send: dispatch }).sendPasswordReset({ email: 'writer@example.test', token: 'token',
      expiresAt: future })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('requires at least one membership and restricts management and publication', () => {
    const principal = { userId: 'user', sessionId: 'session', workspaceId: 'workspace', clientType: 'browser' as const,
      roles: [] as const, actorType: 'user' as const }
    expect(canPerform(principal, 'content:read')).toBe(false)
    expect(canPerform(principal, 'workspace:manage')).toBe(false)
    expect(canPerform({ ...principal, roles: ['admin'] }, 'workspace:manage')).toBe(true)
    expect(canPerform({ ...principal, roles: ['editor'] }, 'proposal:publish')).toBe(false)
  })

  it('fails closed on unexpected Redis counter replies', async () => {
    const limiter = new RedisAuthRateLimiter({ send: async () => 'unexpected' })
    await expect(limiter.consume('key', 1, 1000)).resolves.toBe(false)
    for (const [limit, window] of [[1.5, 1000], [0, 1000], [1, 1.5], [1, 0]]) {
      await expect(limiter.consume('key', limit ?? 0, window ?? 0)).rejects.toThrow('positive integers')
    }
    await expect(limiter.block('key', 0)).rejects.toThrow('positive integer')
  })
})

describe('principal resolution rejects incomplete or stale server identity', () => {
  it('resolves a valid official-client principal and rejects absent browser credentials', async () => {
    await expect(resolveAuthPrincipal({ headers: { authorization: `Bearer ${accessToken()}` }, now: () => now,
      accessToken: access, sessionResolver: { findSessionById: async () => session }, resolveIdentity: async () => identity }))
      .resolves.toMatchObject({ ...identity, sessionId: 'session', clientType: 'official-client', actorType: 'user' })
    for (const headers of [{}, { cookie: 'irrelevant=one' }, { cookie: '__Host-dsh_session=secret' }]) {
      await expect(resolveAuthPrincipal({ headers, sessionResolver: {}, resolveIdentity: async () => identity })).resolves.toBeNull()
    }
  })
  it('requires JWT verification settings and a session-ID resolver', async () => {
    await expect(resolveAuthPrincipal({ headers: { authorization: `Bearer ${accessToken()}` }, now: () => now,
      sessionResolver: {}, resolveIdentity: async () => identity })).resolves.toBeNull()
    await expect(resolveAuthPrincipal({ headers: { authorization: `Bearer ${accessToken()}` }, now: () => now,
      accessToken: access, sessionResolver: {}, resolveIdentity: async () => identity })).resolves.toBeNull()
  })

  it.each([null, { ...session, expiresAt: now }])('rejects missing or expired official sessions', async (value) => {
    await expect(resolveAuthPrincipal({ headers: { authorization: `Bearer ${accessToken()}` }, now: () => now,
      accessToken: access, sessionResolver: { findSessionById: async () => value },
      resolveIdentity: async () => identity })).resolves.toBeNull()
  })

  it('returns null for an identity resolver error and mismatched official-client identities', async () => {
    await expect(resolveAuthPrincipal({ headers: { cookie: '__Host-dsh_session=secret' }, now: () => now,
      sessionResolver: { findSessionByTokenHash: async () => { throw new Error('lookup unavailable') } },
      resolveIdentity: async () => identity })).resolves.toBeNull()
    for (const value of [{ ...session, userId: 'other' }, { ...session, sessionId: 'other' }, { ...session,
      clientType: 'browser' as const }, { ...session, revokedAt: now }]) {
      await expect(resolveAuthPrincipal({ headers: { authorization: `Bearer ${accessToken()}` }, now: () => now,
        accessToken: access, sessionResolver: { findSessionById: async () => value },
        resolveIdentity: async () => identity })).resolves.toBeNull()
    }
  })

  it.each([null, { ...session, clientType: 'browser' as const, expiresAt: now }])('rejects missing or expired browser sessions',
    async (value) => {
      await expect(resolveAuthPrincipal({ headers: { cookie: 'irrelevant=x; __Host-dsh_session=one=two' }, now: () => now,
        sessionResolver: { findSessionByTokenHash: async () => value }, resolveIdentity: async () => identity })).resolves.toBeNull()
    })

  it.each([null, { ...identity, userId: ' ' }, { ...identity, workspaceId: ' ' }, { ...identity, roles: [] }])(
    'rejects unusable workspace identity %j', async (value) => {
      await expect(resolveAuthPrincipal({ headers: { cookie: '__Host-dsh_session=secret' }, now: () => now,
        sessionResolver: { findSessionByTokenHash: async () => ({ ...session, clientType: 'browser' }) },
        resolveIdentity: async () => value })).resolves.toBeNull()
    },
  )

  it('continues resolving valid official clients after rejecting a stale session', async () => {
    const lookup = vi.fn().mockResolvedValueOnce({ ...session, revokedAt: now }).mockResolvedValue(session)
    const request = { headers: { authorization: `Bearer ${accessToken()}` }, now: () => now,
      accessToken: access, sessionResolver: { findSessionById: lookup }, resolveIdentity: async () => identity }
    await expect(resolveAuthPrincipal(request)).resolves.toBeNull()
    await expect(resolveAuthPrincipal(request)).resolves.toMatchObject({ ...identity, clientType: 'official-client' })
  })
})

describe('authentication HTTP rejection and adapter contracts', () => {
  it.each([undefined, null, '{', 'null', '[]', '7', '"text"', [], 7])('rejects unusable JSON register body %j', async (body) => {
    const { http } = controller()
    expect((await http.handle({ method: 'POST', path: '/api/auth/register', headers: {},
      ...(body === undefined ? {} : { body }) })).status).toBe(400)
  })

  it('accepts string JSON objects and returns 404 for unknown routes', async () => {
    const { http, auth } = controller()
    vi.spyOn(auth, 'register').mockResolvedValue({ userId: 'user', verificationToken: 'raw' })
    expect((await http.handle({ method: 'POST', path: '/api/auth/register', headers: {},
      body: '{"email":"writer@example.test","password":"long password"}' })).status).toBe(202)
    expect((await http.handle({ method: 'GET', path: '/missing', headers: {} })).status).toBe(404)
  })

  it.each(['register', 'login'] as const)('returns 429 when %s exceeds its budget', async (route) => {
    const { http } = controller({ security: security(false).controls })
    expect((await http.handle({ method: 'POST', path: `/api/auth/${route}`, headers: {}, remoteAddress: 'peer',
      body: { email: 'writer@example.test', password: 'long password' } })).status).toBe(429)
  })

  it.each([true, false])('sends registration mail through security controls=%s', async (useSecurity) => {
    const delivery = security()
    const { http, auth } = controller(useSecurity ? { security: delivery.controls } : { mail: delivery.mail })
    vi.spyOn(auth, 'register').mockResolvedValue({ userId: 'user', verificationToken: 'raw' })
    expect((await http.handle({ method: 'POST', path: '/api/auth/register', headers: {}, body: { email: 'writer@example.test',
      password: 'long password' } })).status).toBe(202)
    expect(delivery.send).toHaveBeenCalledOnce()
  })

  it('requires fields and distinguishes rejected email tokens', async () => {
    const { http, auth } = controller()
    expect((await http.handle({ method: 'POST', path: '/api/auth/login', headers: {} })).status).toBe(400)
    expect((await http.handle({ method: 'POST', path: '/api/auth/verify-email', headers: {} })).status).toBe(400)
    vi.spyOn(auth, 'verifyEmail').mockResolvedValue(false)
    expect((await http.handle({ method: 'POST', path: '/api/auth/verify-email', headers: {}, body: { token: 'bad' } })).status).toBe(400)
    expect((await http.handle({ method: 'POST', path: '/api/auth/reset-password', headers: {} })).status).toBe(400)
    vi.spyOn(auth, 'verifyEmail').mockResolvedValue(true)
    expect((await http.handle({ method: 'POST', path: '/api/auth/verify-email', headers: {}, body: { token: 'valid' } })).status).toBe(204)
    vi.spyOn(auth, 'resetPassword').mockResolvedValue(true)
    expect((await http.handle({ method: 'POST', path: '/api/auth/reset-password', headers: {}, body: { token: 'valid',
      password: 'a valid long password' } })).status).toBe(204)
  })

  it('finishes logout when its session adapter is detached during a pending lookup', async () => {
    const options: AuthHttpControllerOptions = { sessionResolver: {
      findSessionByTokenHash: async () => {
        Reflect.deleteProperty(options, 'sessionResolver')
        return { ...session, clientType: 'browser' }
      },
      revokeSession: async () => { throw new Error('Detached resolver must not be called') },
    } }
    // Pass the same dependency object so the lookup models adapter teardown, not a replacement controller.
    const http = new AuthHttpController(new UserAuthService(storeFixture().store), new MemoryRefreshTokenStore(), options)
    expect((await http.handle({ method: 'POST', path: '/api/auth/logout',
      headers: { cookie: '__Host-dsh_session=secret' } })).status).toBe(204)
  })

  it('returns 401 for a rejected password and invalid or absent refresh credentials', async () => {
    const { http } = controller({ sessionResolver: { findSessionById: async () => session,
      findSessionByTokenHash: async () => null, revokeSession: async () => undefined } })
    expect((await http.handle({ method: 'POST', path: '/api/auth/login', headers: {}, body: { email: 'writer@example.test',
      password: 'password' } })).status).toBe(401)
    expect((await http.handle({ method: 'POST', path: '/api/auth/refresh', headers: {} })).status).toBe(401)
    expect((await http.handle({ method: 'POST', path: '/api/auth/refresh',
      headers: { authorization: 'Bearer unknown' } })).status).toBe(401)
  })

  it.each([{}, { resolveIdentity: async () => null },
    { resolveIdentity: async () => identity }])('fails closed for missing identity or access settings', async (options) => {
    const { http, auth } = controller(options)
    vi.spyOn(auth, 'login').mockResolvedValue({ userId: 'user', sessionId: 'session', sessionToken: 'raw', clientType: 'official-client' })
    expect((await http.handle({ method: 'POST', path: '/api/auth/login', headers: {}, body: { email: 'writer@example.test',
      password: 'password', clientType: 'official-client' } })).status).toBe(500)
  })

  it.each([undefined, null, { ...session, expiresAt: now }])('rejects browser session resolution %j', async (value) => {
    const options = value === undefined ? {} : { sessionResolver: { findSessionByTokenHash: async () => value,
      revokeSession: async () => undefined } }
    const { http } = controller(options)
    expect((await http.handle({ method: 'GET', path: '/api/auth/me', headers: { cookie: '__Host-dsh_session=secret' } })).status).toBe(401)
  })

  it('does not authenticate missing browser cookies or invalid official access tokens', async () => {
    const resolver = { findSessionByTokenHash: async () => null, revokeSession: async () => undefined }
    const { http } = controller({ sessionResolver: resolver })
    expect((await http.handle({ method: 'GET', path: '/api/auth/me', headers: {} })).status).toBe(401)
    expect((await http.handle({ method: 'GET', path: '/api/auth/me', headers: { authorization: 'Bearer invalid' } })).status).toBe(401)
    const withAccess = controller({ sessionResolver: { ...resolver, findSessionById: async () => session }, accessToken: access })
    expect((await withAccess.http.handle({ method: 'GET', path: '/api/auth/me',
      headers: { authorization: 'Bearer invalid' } })).status).toBe(401)
  })

  it.each([null, { ...session, userId: 'other' }, { ...session, sessionId: 'other' }, { ...session,
    clientType: 'browser' as const }, { ...session, revokedAt: now }, { ...session, expiresAt: now }])(
    'rejects invalid official session state %j', async (value) => {
      const { http } = controller({ accessToken: access, sessionResolver: { findSessionById: async () => value,
        findSessionByTokenHash: async () => null, revokeSession: async () => undefined } })
      expect((await http.handle({ method: 'GET', path: '/api/auth/me',
        headers: { authorization: `Bearer ${accessToken()}` } })).status).toBe(401)
    },
  )

  it.each([true, false])('sends reset mail through security controls=%s', async (useSecurity) => {
    const delivery = security()
    const { http, auth } = controller(useSecurity ? { security: delivery.controls } : { mail: delivery.mail })
    vi.spyOn(auth, 'issuePasswordReset').mockResolvedValue('raw-reset')
    expect((await http.handle({ method: 'POST', path: '/api/auth/forgot-password', headers: {},
      body: { email: 'writer@example.test' } })).status).toBe(202)
    expect(delivery.reset).toHaveBeenCalledOnce()
  })

  it('keeps forgot-password accepted without leaking unknown accounts or exhausted budgets', async () => {
    const noMail = controller()
    vi.spyOn(noMail.auth, 'issuePasswordReset').mockResolvedValue('reset')
    for (const body of [{}, { email: 'writer@example.test' }]) expect((await noMail.http.handle({ method: 'POST',
      path: '/api/auth/forgot-password', headers: {}, body })).status).toBe(202)
    const limited = controller({ security: security(false).controls })
    expect((await limited.http.handle({ method: 'POST', path: '/api/auth/forgot-password', headers: {},
      body: { email: 'writer@example.test' } })).status).toBe(202)
  })
})

describe('access token cryptographic and time constraints', () => {
  it.each([0, 299, 901, 600.5])('rejects unsupported lifetime %s', (ttlSeconds) => {
    expect(() => createAccessToken({ userId: 'user', sessionId: 'session', scope: [] }, { ...access, ttlSeconds })).toThrow('TTL')
  })

  it('uses current time when explicit clocks are omitted', () => {
    const { privateKey, publicKey } = keys
    const token = createAccessToken({ userId: 'user', sessionId: 'session', scope: [] }, { privateKey, issuer: 'dsh', audience: 'api' })
    expect(verifyAccessToken(token, { publicKey, issuer: 'dsh', audience: 'api' }).sub).toBe('user')
  })

  it('rejects malformed token counts and invalid signatures', () => {
    expect(() => verifyAccessToken('one.two', access)).toThrow(AccessTokenInvalidError)
    const token = accessToken().split('.')
    expect(() => verifyAccessToken(`${token[0]}.${token[1]}.${Buffer.alloc(64).toString('base64url')}`,
      access)).toThrow(AccessTokenInvalidError)
  })

  it.each([{ iat: Math.floor(now.getTime() / 1000) + 31 }, { exp: Math.floor(now.getTime() / 1000) }, { iat: 0, exp: 901 },
    { iss: 'other' }, { aud: 'other' }])(
    'rejects correctly signed invalid issuer, audience or timestamps %j', (override) => {
      const encodedHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url')
      const claims = { iss: 'dsh', aud: 'api', sub: 'user', sid: 'session', jti: 'id', iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(now.getTime() / 1000) + 600, scope: [], ...override }
      const input = `${encodedHeader}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
      const token = `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString('base64url')}`
      expect(() => verifyAccessToken(token, access)).toThrow(AccessTokenInvalidError)
    },
  )
})
