import { describe, expect, it } from 'vitest'
import { emailVerificationTokens, passwordResetTokens, sessions, users } from '@deepseek-ai/dsh-database-postgres'
import { PostgresAuthStore, type AuthUserRecord } from '../src/index.ts'

const now = new Date('2026-11-09T00:00:00Z')
const user: AuthUserRecord = {
  id: 'user', email: 'Writer@example.test', emailNormalized: 'writer@example.test', passwordHash: 'stored-digest',
  status: 'active', emailVerifiedAt: now, failedLoginCount: 2, lockedUntil: null,
}

function fixture(results: unknown[][] = [], clock: (() => Date) | null = () => now) {
  const operations: Array<{ kind: string; table?: unknown; value?: unknown; condition?: unknown }> = []
  function query(result: unknown, operation: (typeof operations)[number]) {
    const promise = Promise.resolve(result)
    const builder = {
      from: (table: unknown) => { operation.table = table; return builder },
      where: (condition: unknown) => { operation.condition = condition; return builder },
      limit: (_count: number) => builder,
      for: (_strength: string) => builder,
      groupBy: (_column: unknown) => builder,
      orderBy: (_column: unknown) => builder,
      set: (value: unknown) => { operation.value = value; return builder },
      values: (value: unknown) => { operation.value = value; return builder },
      returning: (_selection: unknown) => builder,
      then: promise.then.bind(promise),
    }
    return builder
  }
  function operation(kind: string, table?: unknown) {
    const entry = { kind, table }
    operations.push(entry)
    return query(results.shift() ?? [], entry)
  }
  const db = {
    select: (_selection?: unknown) => operation('select'),
    insert: (table: unknown) => operation('insert', table),
    update: (table: unknown) => operation('update', table),
    execute: async (_statement: unknown) => undefined,
  }
  const client = { db: { ...db, transaction: async <T>(callback: (tx: typeof db) => Promise<T>) => {
    operations.push({ kind: 'transaction' })
    return callback(db)
  } } }
  const store = clock === null ? new PostgresAuthStore(client as never) : new PostgresAuthStore(client as never, clock)
  return { store, operations }
}

describe('PostgreSQL authentication persistence contracts', () => {
  it('maps stored user metadata and returns null for an unknown address', async () => {
    const { store, operations } = fixture([[{ ...user, passwordChangedAt: now }], []])
    await expect(store.findUserByEmail(user.emailNormalized)).resolves.toEqual({ ...user, passwordChangedAt: now })
    await expect(store.findUserByEmail('missing@example.test')).resolves.toBeNull()
    expect(operations.every(operation => operation.table === users && operation.condition !== undefined)).toBe(true)
  })

  it.each([undefined, now])('persists pending password timestamp %s and verification material without plaintext', async (passwordChangedAt) => {
    const { store, operations } = fixture()
    const pending = { id: user.id, email: user.email, emailNormalized: user.emailNormalized, passwordHash: user.passwordHash, status: 'pending' as const,
      ...(passwordChangedAt === undefined ? {} : { passwordChangedAt }) }
    await store.insertPendingUser(pending)
    await store.createEmailVerificationToken(user.id, 'verification-digest', now)
    expect(operations).toEqual([
      { kind: 'insert', table: users, value: { ...pending, passwordChangedAt: now } },
      { kind: 'insert', table: emailVerificationTokens, value: { userId: user.id, tokenHash: 'verification-digest', expiresAt: now } },
    ])
  })

  it.each([undefined, now])('registers user and verification together with password timestamp %s', async (passwordChangedAt) => {
    const { store, operations } = fixture()
    const pending = { id: user.id, email: user.email, emailNormalized: user.emailNormalized, passwordHash: user.passwordHash, status: 'pending' as const,
      ...(passwordChangedAt === undefined ? {} : { passwordChangedAt }) }
    await store.registerPendingUser(pending, 'verification-digest', now)
    expect(operations).toEqual([
      { kind: 'transaction' },
      { kind: 'insert', table: users, value: { ...pending, passwordChangedAt: now } },
      { kind: 'insert', table: emailVerificationTokens, value: { userId: user.id, tokenHash: 'verification-digest', expiresAt: now } },
    ])
  })

  it.each([[1.5, 1000], [0, 1000], [1, 1.5], [1, 0]])('rejects unsafe login-lock values %s/%s before a write', async (threshold, duration) => {
    const { store, operations } = fixture()
    await expect(store.recordFailedLogin(user.id, now, threshold, duration)).rejects.toThrow('positive integers')
    expect(operations).toEqual([])
  })

  it('uses SQL-side failed counters and clears successful-login state', async () => {
    const { store, operations } = fixture()
    await store.recordFailedLogin(user.id, now, 5, 60000)
    await store.recordSuccessfulLogin(user.id, now)
    expect(operations[0]).toMatchObject({ kind: 'update', table: users, value: { updatedAt: now } })
    const failedValues = operations[0]?.value as Record<string, unknown>
    expect(failedValues.failedLoginCount).toBeDefined()
    expect(failedValues.lockedUntil).toBeDefined()
    expect(operations[1]).toMatchObject({ kind: 'update', table: users, value: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now } })
    expect(operations.every(operation => operation.condition !== undefined)).toBe(true)
  })

  it.each(['browser', 'official-client'] as const)('creates a %s session with its SQL client type and hash', async (clientType) => {
    const { store, operations } = fixture([[{ id: 'session' }]])
    const input = { userId: user.id, tokenHash: 'session-digest', clientType, expiresAt: now, userAgent: 'test-client', ipHash: 'ip-digest' }
    await expect(store.createSession(input)).resolves.toEqual({ id: 'session' })
    expect(operations[0]).toEqual({ kind: 'insert', table: sessions, value: {
      ...input, clientType: clientType === 'browser' ? 'web' : 'official_client', lastSeenAt: now,
    } })
  })

  it('rejects session insertion without a returned identity', async () => {
    const { store } = fixture([[]])
    await expect(store.createSession({ userId: user.id, tokenHash: 'hash', clientType: 'browser', expiresAt: now })).rejects.toThrow('session was not created')
  })

  it('creates and consumes reset hashes, returning null when already consumed or unknown', async () => {
    const { store, operations } = fixture([[], [{ userId: user.id }], []])
    await store.createPasswordResetToken(user.id, 'reset-digest', now)
    await expect(store.consumePasswordResetToken('reset-digest', now)).resolves.toBe(user.id)
    await expect(store.consumePasswordResetToken('missing', now)).resolves.toBeNull()
    expect(operations[0]).toEqual({ kind: 'insert', table: passwordResetTokens, value: { userId: user.id, tokenHash: 'reset-digest', expiresAt: now } })
    expect(operations.slice(1).every(operation => operation.table === passwordResetTokens && operation.condition !== undefined)).toBe(true)
  })

  it('updates password timestamps and revokes only the selected session or user', async () => {
    const { store, operations } = fixture()
    await store.updatePassword(user.id, 'new-hash', now)
    await store.revokeUserSessions(user.id)
    await store.revokeSession('session')
    expect(operations.map(operation => operation.value)).toEqual([
      { passwordHash: 'new-hash', passwordChangedAt: now, updatedAt: now }, { revokedAt: now }, { revokedAt: now },
    ])
    expect(operations.map(operation => operation.table)).toEqual([users, sessions, sessions])
    expect(operations.every(operation => operation.condition !== undefined)).toBe(true)
  })

  for (const method of ['findSessionByTokenHash', 'findSessionById'] as const) {
    it(`${method} maps both client categories and missing sessions`, async () => {
      const base = { userId: user.id, sessionId: 'session', expiresAt: now, revokedAt: null }
      const { store } = fixture([[{ ...base, clientType: 'web' }], [{ ...base, clientType: 'official_client' }], []])
      await expect(store[method]('session')).resolves.toEqual({ ...base, clientType: 'browser' })
      await expect(store[method]('session')).resolves.toEqual({ ...base, clientType: 'official-client' })
      await expect(store[method]('missing')).resolves.toBeNull()
    })
  }

  it('leaves a missing reset owner and a vanished revoke owner unchanged', async () => {
    const reset = fixture([[]])
    await reset.store.resetPassword('missing', 'new-hash', now)
    expect(reset.operations.map(operation => operation.kind)).toEqual(['transaction', 'select'])
    const revoke = fixture([[{ userId: 'missing' }], []])
    await revoke.store.revokeFamily('family')
    expect(revoke.operations.map(operation => operation.kind)).toEqual(['transaction', 'select', 'select'])
  })

  it('uses a real clock when none is supplied', async () => {
    const start = Date.now()
    const { store, operations } = fixture([], null)
    await store.revokeSession('session')
    const values = operations[0]?.value as { revokedAt: Date }
    expect(values.revokedAt.getTime()).toBeGreaterThanOrEqual(start)
    expect(values.revokedAt.getTime()).toBeLessThanOrEqual(Date.now())
  })
})
