import { describe, expect, it } from 'vitest'
import { PostgresAuthStore, PostgresRefreshTokenStore } from '../src/index.ts'

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
    for (const method of ['create', 'findByHash', 'rotate', 'revokeFamily']) {
      expect(typeof (PostgresRefreshTokenStore.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })
})
