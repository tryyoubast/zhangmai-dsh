import { describe, expect, it } from 'vitest'
import type { AuthStore, AuthUserRecord } from '../src/index.ts'
import { hashToken, UserAuthService } from '../src/index.ts'

class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUserRecord>()
  readonly sessions: Array<{ id: string; userId: string; tokenHash: string }> = []
  verification?: { userId: string; tokenHash: string; expiresAt: Date }

  findUserByEmail(emailNormalized: string): Promise<AuthUserRecord | null> {
    return Promise.resolve([...this.users.values()].find(user => user.emailNormalized === emailNormalized) ?? null)
  }

  insertPendingUser(user: Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>): Promise<void> {
    this.users.set(user.id, { ...user, emailVerifiedAt: null, failedLoginCount: 0, lockedUntil: null })
    return Promise.resolve()
  }

  createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    this.verification = { userId, tokenHash, expiresAt }
    return Promise.resolve()
  }

  recordFailedLogin(userId: string, now: Date, threshold: number, lockDurationMs: number): Promise<void> {
    const user = this.users.get(userId)
    if (user === undefined) throw new Error('user missing')
    const failed = user.failedLoginCount + 1
    this.users.set(userId, {
      ...user,
      failedLoginCount: failed,
      lockedUntil: failed >= threshold ? new Date(now.getTime() + lockDurationMs) : null,
    })
    return Promise.resolve()
  }

  recordSuccessfulLogin(userId: string, _now: Date): Promise<void> {
    const user = this.users.get(userId)
    if (user === undefined) throw new Error('user missing')
    this.users.set(userId, { ...user, failedLoginCount: 0, lockedUntil: null })
    return Promise.resolve()
  }

  createSession(input: { userId: string; tokenHash: string; clientType: 'browser' | 'official-client'; expiresAt: Date }): Promise<{ id: string }> {
    const id = `session-${String(this.sessions.length + 1)}`
    this.sessions.push({ id, userId: input.userId, tokenHash: input.tokenHash })
    return Promise.resolve({ id })
  }
}

describe('UserAuthService', () => {
  it('registers a pending user and stores only a verification-token hash', async () => {
    const store = new MemoryAuthStore()
    const result = await new UserAuthService(store, { now: () => new Date('2026-01-01T00:00:00Z') }).register(
      ' Writer@Example.com ', 'a sufficiently long password',
    )
    expect(store.users.get(result.userId)?.status).toBe('pending')
    expect(store.verification?.tokenHash).toBe(hashToken(result.verificationToken))
    expect(store.verification?.tokenHash).not.toBe(result.verificationToken)
  })

  it('does not authenticate pending users or reveal whether an account exists', async () => {
    const store = new MemoryAuthStore()
    const service = new UserAuthService(store)
    await service.register('writer@example.com', 'a sufficiently long password')
    await expect(service.login('writer@example.com', 'a sufficiently long password', 'browser')).resolves.toBeNull()
    await expect(service.login('missing@example.com', 'a sufficiently long password', 'browser')).resolves.toBeNull()
  })

  it('creates a one-time opaque session token only after successful login', async () => {
    const store = new MemoryAuthStore()
    const service = new UserAuthService(store)
    const registration = await service.register('writer@example.com', 'a sufficiently long password')
    const user = store.users.get(registration.userId)
    if (user === undefined) throw new Error('user missing')
    store.users.set(user.id, { ...user, status: 'active', emailVerifiedAt: new Date() })
    const result = await service.login('writer@example.com', 'a sufficiently long password', 'browser')
    expect(result?.sessionToken).toBeDefined()
    expect(store.sessions[0]?.tokenHash).toBe(hashToken(result?.sessionToken ?? ''))
  })
})
