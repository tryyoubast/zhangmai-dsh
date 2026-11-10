import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { MemoryRefreshTokenStore } from './refresh-memory.ts'
import {
  AccessTokenInvalidError,
  createAccessToken,
  AuthSecurityControls,
  UserAuthService,
  type AuthLifecycleStore,
  type AuthUserRecord,
  hashToken,
  verifyAccessToken,
  RefreshTokenService,
  RedisAuthRateLimiter,
  AuthTemplateMailProvider,
} from '../src/index.ts'

class LifecycleStore implements AuthLifecycleStore {
  readonly users = new Map<string, AuthUserRecord>()
  readonly verification = new Map<string, { userId: string; expiresAt: Date; consumedAt: Date | null }>()
  readonly resets = new Map<string, { userId: string; expiresAt: Date; consumedAt: Date | null }>()
  readonly revokedSessions: string[] = []
  passwordHash = 'old-hash'

  findUserByEmail(emailNormalized: string): Promise<AuthUserRecord | null> {
    return Promise.resolve([...this.users.values()].find(user => user.emailNormalized === emailNormalized) ?? null)
  }
  insertPendingUser(user: Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>): Promise<void> {
    this.users.set(user.id, { ...user, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: null })
    return Promise.resolve()
  }
  createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    this.verification.set(tokenHash, { userId, expiresAt, consumedAt: null })
    return Promise.resolve()
  }
  recordFailedLogin(): Promise<void> { return Promise.resolve() }
  recordSuccessfulLogin(): Promise<void> { return Promise.resolve() }
  createSession(): Promise<{ id: string }> { return Promise.resolve({ id: 'session-1' }) }
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
  updatePassword(userId: string, passwordHashValue: string, now: Date): Promise<void> {
    this.passwordHash = passwordHashValue
    const user = this.users.get(userId)
    if (user !== undefined) this.users.set(userId, { ...user, passwordHash: passwordHashValue, passwordChangedAt: now })
    return Promise.resolve()
  }
  revokeUserSessions(userId: string): Promise<void> {
    this.revokedSessions.push(userId)
    return Promise.resolve()
  }
}

describe('authentication lifecycle', () => {
  it('uses atomic Redis commands for rate limits and a template-only mail adapter', async () => {
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const limiter = new RedisAuthRateLimiter({
      send: async (command, ...args) => {
        commands.push({ command, args })
        return 1
      },
    })
    await expect(limiter.consume('auth:test', 3, 60_000)).resolves.toBe(true)
    await limiter.block('auth:test', 15_000)
    const sent: unknown[] = []
    const mail = new AuthTemplateMailProvider({ send: async (input) => { sent.push(input) } })
    await mail.sendEmailVerification({ email: 'writer@example.com', token: 'opaque', expiresAt: new Date('2026-01-01T00:00:00Z') })
    expect(commands[0]?.command).toBe('EVAL')
    expect(commands[1]?.command).toBe('SET')
    expect(JSON.stringify(sent)).toContain('opaque')
  })
  it('consumes email verification tokens exactly once', async () => {
    const store = new LifecycleStore()
    const service = new UserAuthService(store, { now: () => new Date('2026-01-01T00:00:00Z') })
    const registration = await service.register('writer@example.com', 'a sufficiently long password')
    await expect(service.verifyEmail(registration.verificationToken)).resolves.toBe(true)
    await expect(service.verifyEmail(registration.verificationToken)).resolves.toBe(false)
    expect(store.users.get(registration.userId)?.status).toBe('active')
  })

  it('rejects expired and unknown email verification tokens without consuming the valid token', async () => {
    const store = new LifecycleStore()
    const service = new UserAuthService(store, { now: () => new Date('2026-01-01T00:00:00Z') })
    const registration = await service.register('writer@example.com', 'a sufficiently long password')
    const token = store.verification.get(hashToken(registration.verificationToken))
    if (token === undefined) throw new Error('verification token missing')
    token.expiresAt = new Date('2025-12-31T23:59:59Z')

    await expect(service.verifyEmail(registration.verificationToken)).resolves.toBe(false)
    await expect(service.verifyEmail('unknown-token')).resolves.toBe(false)
    expect(token.consumedAt).toBeNull()
    expect(store.users.get(registration.userId)?.status).toBe('pending')
  })

  it('does not consume an email verification token when its user cannot be activated', async () => {
    const store = new LifecycleStore()
    const service = new UserAuthService(store, { now: () => new Date('2026-01-01T00:00:00Z') })
    const registration = await service.register('writer@example.com', 'a sufficiently long password')
    const tokenHash = hashToken(registration.verificationToken)
    store.users.delete(registration.userId)

    await expect(service.verifyEmail(registration.verificationToken)).rejects.toThrow('user missing')
    expect(store.verification.get(tokenHash)?.consumedAt).toBeNull()
  })

  it('resets a password and revokes existing sessions without exposing token material', async () => {
    const store = new LifecycleStore()
    const service = new UserAuthService(store, { now: () => new Date('2026-01-01T00:00:00Z') })
    const registration = await service.register('writer@example.com', 'a sufficiently long password')
    const resetToken = await service.issuePasswordReset('writer@example.com')
    expect(resetToken).not.toBeNull()
    expect(store.resets.has(hashToken(resetToken ?? ''))).toBe(true)
    await expect(service.resetPassword(resetToken ?? '', 'a different long password')).resolves.toBe(true)
    await expect(service.resetPassword(resetToken ?? '', 'another long password')).resolves.toBe(false)
    expect(store.revokedSessions).toContain(registration.userId)
  })

  it('issues and verifies short-lived EdDSA access tokens with audience and issuer claims', () => {
    const keys = generateKeyPairSync('ed25519')
    const token = createAccessToken({ userId: 'user-1', sessionId: 'session-1', scope: ['novel:read'] }, {
      privateKey: keys.privateKey,
      issuer: 'dsh',
      audience: 'dsh-client',
      now: 1_700_000_000_000,
      ttlSeconds: 600,
    })
    const claims = verifyAccessToken(token, {
      publicKey: keys.publicKey,
      issuer: 'dsh',
      audience: 'dsh-client',
      now: 1_700_000_100_000,
    })
    expect(claims.sub).toBe('user-1')
    expect(claims.scope).toEqual(['novel:read'])
  })

  it('namespaces rate-limit keys and forwards mail expiry without logging secrets', async () => {
    const calls: string[] = []
    const controls = new AuthSecurityControls({
      consume: async (key) => { calls.push(key); return true },
      block: async (key) => { calls.push(`block:${key}`) },
    }, {
      sendEmailVerification: async (input) => { calls.push(`verify:${input.email}:${input.expiresAt.toISOString()}`) },
      sendPasswordReset: async (input) => { calls.push(`reset:${input.email}:${input.expiresAt.toISOString()}`) },
    }, () => new Date('2026-01-01T00:00:00Z'))
    await expect(controls.consumeLoginAttempt('ip-hash')).resolves.toBe(true)
    await controls.sendVerification('writer@example.com', 'opaque-token', 60_000)
    await controls.blockLogin('ip-hash', 1_000)
    expect(calls[0]).toBe('auth:login:ip-hash')
    expect(calls.join('|')).not.toContain('opaque-token')
  })

  it('rotates refresh tokens and revokes a family when an old token is reused', async () => {
    const store = new MemoryRefreshTokenStore()
    const service = new RefreshTokenService(store, () => new Date('2026-01-01T00:00:00Z'))
    const first = await service.issue('user-1', 'session-1')
    const second = await service.rotate(first.token)
    if (second === null) throw new Error('refresh rotation unexpectedly failed')
    expect(second.token).not.toBe(first.token)
    await expect(service.rotate(first.token)).resolves.toBeNull()
    expect(store.revokedFamilies).toContain(first.familyId)
  })
})

describe('signed access-token JSON validation', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const header = { alg: 'EdDSA', typ: 'JWT' }
  const claims = {
    iss: 'dsh', aud: 'dsh-client', sub: 'user-1', sid: 'session-1', jti: 'token-1',
    iat: 1_700_000_000, exp: 1_700_000_600, scope: ['novel:read'],
  }
  const options = { publicKey, issuer: 'dsh', audience: 'dsh-client', now: 1_700_000_100_000 }

  function signedJson(headerJson: string, claimsJson: string): string {
    const input = `${Buffer.from(headerJson).toString('base64url')}.${Buffer.from(claimsJson).toString('base64url')}`
    return `${input}.${sign(null, Buffer.from(input, 'ascii'), privateKey).toString('base64url')}`
  }

  describe.each(['header', 'payload'] as const)('%s', (part) => {
    it.each(['{', 'null', '[]', '"text"', '7', 'true', '{}'])('rejects signed JSON %s with AccessTokenInvalidError', (json) => {
      const token = signedJson(part === 'header' ? json : JSON.stringify(header), part === 'payload' ? json : JSON.stringify(claims))
      expect(() => verifyAccessToken(token, options)).toThrow(AccessTokenInvalidError)
    })
  })

  it.each([
    { field: 'alg', value: 'HS256' },
    { field: 'alg', value: 1 },
    { field: 'typ', value: 'other' },
    { field: 'typ', value: null },
  ])('rejects signed header field $field=$value', ({ field, value }) => {
    const token = signedJson(JSON.stringify({ ...header, [field]: value }), JSON.stringify(claims))
    expect(() => verifyAccessToken(token, options)).toThrow(AccessTokenInvalidError)
  })

  it.each([
    { field: 'iss', value: 1 },
    { field: 'aud', value: ['dsh-client'] },
    { field: 'sub', value: null },
    { field: 'sid', value: false },
    { field: 'jti', value: 1 },
    { field: 'iat', value: '1700000000' },
    { field: 'exp', value: '1700000600' },
    { field: 'scope', value: 'novel:read' },
    { field: 'scope', value: [1] },
  ])('rejects signed claim field $field=$value', ({ field, value }) => {
    const token = signedJson(JSON.stringify(header), JSON.stringify({ ...claims, [field]: value }))
    expect(() => verifyAccessToken(token, options)).toThrow(AccessTokenInvalidError)
  })

  it.each(Object.keys(claims))('rejects a signed payload without %s', (field) => {
    const incomplete = Object.fromEntries(Object.entries(claims).filter(([key]) => key !== field))
    const token = signedJson(JSON.stringify(header), JSON.stringify(incomplete))
    expect(() => verifyAccessToken(token, options)).toThrow(AccessTokenInvalidError)
  })

  it('preserves valid signed claims after JSON validation', () => {
    expect(verifyAccessToken(signedJson(JSON.stringify(header), JSON.stringify(claims)), options)).toEqual(claims)
  })
})
