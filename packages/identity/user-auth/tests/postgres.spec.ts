import { describe, expect, it } from 'vitest'
import {
  PostgresAuthStore,
  PostgresRefreshTokenStore,
  type RefreshTokenRecord,
  type RefreshTokenReplacement,
} from '../src/index.ts'

function verificationDatabase(
  userRows: readonly { id: string }[] = [{ id: 'user-1' }],
  tokenRows: readonly { userId: string }[] = [{ userId: 'user-1' }],
) {
  let transactionUpdates = 0
  let rootUpdates = 0
  let transactionRejected = false
  let tokenConsumptionCommitted = false
  let tokenConsumptionStaged = false
  const transaction = {
    update: () => {
      const updateNumber = ++transactionUpdates
      const query = {
        set: (_values: unknown) => query,
        where: (..._conditions: unknown[]) => query,
        returning: (_selection: unknown) => {
          if (updateNumber === 1) {
            if (tokenRows.length > 0) tokenConsumptionStaged = true
            return Promise.resolve(tokenRows)
          }
          return Promise.resolve(userRows)
        },
      }
      return query
    },
  }
  const client = {
    db: {
      update: () => {
        rootUpdates += 1
        throw new Error('updates must use the transaction')
      },
      transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        try {
          const result = await operation(transaction)
          tokenConsumptionCommitted = tokenConsumptionStaged
          return result
        } catch (error) {
          transactionRejected = true
          throw error
        }
      },
    },
  }
  return {
    client,
    state: () => ({ transactionUpdates, rootUpdates, transactionRejected, tokenConsumptionCommitted }),
  }
}

const refreshNow = new Date('2026-01-01T00:00:00Z')

function refreshRecord(overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    id: 'token-1',
    userId: 'user-1',
    sessionId: 'session-1',
    familyId: 'family-1',
    tokenHash: 'old-token-hash',
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    usedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

const replacement: RefreshTokenReplacement = {
  id: 'token-2',
  tokenHash: 'replacement-token-hash',
  expiresAt: new Date('2026-02-01T00:00:00Z'),
}

function refreshDatabase(record: RefreshTokenRecord | null, options: { auditFails?: boolean } = {}) {
  const stagedInserts: unknown[] = []
  const stagedUpdates: unknown[] = []
  const committedInserts: unknown[] = []
  const committedUpdates: unknown[] = []
  let lockMode: string | undefined
  let transactionRejected = false

  const transaction = {
    execute: async (_query: unknown) => [],
    select: (_selection?: unknown) => {
      const query = {
        from: (_table: unknown) => query,
        where: (_condition: unknown) => query,
        limit: (_limit: number) => query,
        for: (mode: string) => {
          lockMode = mode
          return Promise.resolve(record === null ? [] : [record])
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          return Promise.resolve(record === null ? [] : [record]).then(resolve, reject)
        },
      }
      return query
    },
    insert: (_table: unknown) => ({
      values: async (values: unknown) => {
        if (options.auditFails === true && typeof values === 'object' && values !== null && 'action' in values) {
          throw new Error('audit insert failed')
        }
        stagedInserts.push(values)
      },
    }),
    update: (_table: unknown) => {
      let values: unknown
      const query = {
        set: (nextValues: unknown) => {
          values = nextValues
          return query
        },
        where: (_condition: unknown) => {
          stagedUpdates.push(values)
          return query
        },
        returning: (_selection: unknown) => Promise.resolve([{ id: record?.id ?? 'token-1' }]),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve([]).then(resolve, reject),
      }
      return query
    },
  }
  const client = {
    db: {
      transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        try {
          const result = await operation(transaction)
          committedInserts.push(...stagedInserts)
          committedUpdates.push(...stagedUpdates)
          return result
        } catch (error) {
          transactionRejected = true
          throw error
        }
      },
    },
  }
  return {
    client,
    state: () => ({ committedInserts, committedUpdates, lockMode, transactionRejected }),
  }
}

describe('PostgreSQL authentication stores', () => {
  it('exposes all atomic lifecycle operations required by authentication', () => {
    for (const method of [
      'findUserByEmail', 'insertPendingUser', 'recordFailedLogin', 'recordSuccessfulLogin',
      'createSession', 'consumeAndActivateEmailVerification',
      'createPasswordResetToken', 'consumePasswordResetToken', 'updatePassword',
      'revokeUserSessions', 'findSessionByTokenHash', 'revokeSession',
      'findSessionById', 'resetPassword',
    ]) {
      expect(typeof (PostgresAuthStore.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('consumes and activates through one transaction', async () => {
    const database = verificationDatabase()
    const store = new PostgresAuthStore(database.client as never)

    await expect(store.consumeAndActivateEmailVerification('token-hash', new Date('2026-01-01T00:00:00Z'))).resolves.toBe(true)
    expect(database.state()).toEqual({
      transactionUpdates: 2,
      rootUpdates: 0,
      transactionRejected: false,
      tokenConsumptionCommitted: true,
    })
  })

  it('returns false when no eligible email verification token matches', async () => {
    const database = verificationDatabase([{ id: 'user-1' }], [])
    const store = new PostgresAuthStore(database.client as never)

    await expect(store.consumeAndActivateEmailVerification('token-hash', new Date('2026-01-01T00:00:00Z'))).resolves.toBe(false)
    expect(database.state()).toEqual({
      transactionUpdates: 1,
      rootUpdates: 0,
      transactionRejected: false,
      tokenConsumptionCommitted: false,
    })
  })

  it('rolls back token consumption when the user update matches no row', async () => {
    const database = verificationDatabase([])
    const store = new PostgresAuthStore(database.client as never)

    await expect(store.consumeAndActivateEmailVerification('token-hash', new Date('2026-01-01T00:00:00Z'))).rejects.toThrow(/user was not activated/u)
    expect(database.state()).toEqual({
      transactionUpdates: 2,
      rootUpdates: 0,
      transactionRejected: true,
      tokenConsumptionCommitted: false,
    })
  })

  it('exposes refresh-token rotation and family revocation', () => {
    for (const method of ['create', 'rotate', 'revokeFamily']) {
      expect(typeof (PostgresRefreshTokenStore.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
    expect((PostgresRefreshTokenStore.prototype as unknown as Record<string, unknown>).findByHash).toBeUndefined()
  })

  it('locks and rotates a valid refresh token in one transaction', async () => {
    const database = refreshDatabase(refreshRecord())
    const store = new PostgresRefreshTokenStore(database.client as never)

    await expect(store.rotate('old-token-hash', replacement, refreshNow)).resolves.toEqual({
      status: 'rotated',
      id: replacement.id,
      userId: 'user-1',
      sessionId: 'session-1',
      familyId: 'family-1',
    })
    expect(database.state()).toEqual({
      committedInserts: [{
        ...replacement,
        userId: 'user-1',
        sessionId: 'session-1',
        familyId: 'family-1',
        usedAt: null,
        revokedAt: null,
      }],
      committedUpdates: [{ usedAt: refreshNow, replacedBy: replacement.id }],
      lockMode: 'update',
      transactionRejected: false,
    })
  })

  it.each([
    ['unknown', null],
    ['expired', refreshRecord({ expiresAt: refreshNow })],
    ['revoked', refreshRecord({ revokedAt: refreshNow })],
  ])('returns invalid for %s refresh tokens without writes', async (_case, record) => {
    const database = refreshDatabase(record)
    const store = new PostgresRefreshTokenStore(database.client as never)

    await expect(store.rotate('old-token-hash', replacement, refreshNow)).resolves.toEqual({ status: 'invalid' })
    expect(database.state()).toEqual({
      committedInserts: [],
      committedUpdates: [],
      lockMode: record === null ? undefined : 'update',
      transactionRejected: false,
    })
  })

  it('revokes a reused token family and writes a secret-free audit event atomically', async () => {
    const database = refreshDatabase(refreshRecord({ usedAt: new Date('2025-12-31T23:59:59Z') }))
    const store = new PostgresRefreshTokenStore(database.client as never)

    await expect(store.rotate('old-token-hash', replacement, refreshNow)).resolves.toEqual({ status: 'reused' })
    const state = database.state()
    expect(state.committedUpdates).toEqual([{ revokedAt: refreshNow }])
    expect(state.committedInserts).toEqual([{
      workspaceId: null,
      actorType: 'system',
      actorId: 'auth.refresh_token_service',
      action: 'auth.refresh_token_reuse_detected',
      targetType: 'refresh_token_family',
      targetId: 'family-1',
      metadata: { userId: 'user-1', sessionId: 'session-1', tokenId: 'token-1' },
      createdAt: refreshNow,
    }])
    expect(state.committedInserts[0]).not.toHaveProperty('token')
    expect(state.committedInserts[0]).not.toHaveProperty('tokenHash')
    expect(JSON.stringify(state.committedInserts[0])).not.toContain('old-token-hash')
  })

  it('rolls back family revocation when the replay audit event cannot be written', async () => {
    const database = refreshDatabase(refreshRecord({ usedAt: new Date('2025-12-31T23:59:59Z') }), { auditFails: true })
    const store = new PostgresRefreshTokenStore(database.client as never)

    await expect(store.rotate('old-token-hash', replacement, refreshNow)).rejects.toThrow('audit insert failed')
    expect(database.state()).toEqual({
      committedInserts: [],
      committedUpdates: [],
      lockMode: 'update',
      transactionRejected: true,
    })
  })
})
