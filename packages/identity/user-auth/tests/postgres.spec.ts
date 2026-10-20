import { describe, expect, it } from 'vitest'
import { PostgresAuthStore, PostgresRefreshTokenStore } from '../src/index.ts'

describe('PostgreSQL authentication stores', () => {
  it('exposes all atomic lifecycle operations required by authentication', () => {
    for (const method of [
      'findUserByEmail', 'insertPendingUser', 'recordFailedLogin', 'recordSuccessfulLogin',
      'createSession', 'consumeEmailVerificationToken', 'activateUser',
      'createPasswordResetToken', 'consumePasswordResetToken', 'updatePassword',
      'revokeUserSessions', 'findSessionByTokenHash', 'revokeSession',
      'findSessionById', 'resetPassword',
    ]) {
      expect(typeof (PostgresAuthStore.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('exposes refresh-token rotation and family revocation', () => {
    for (const method of ['create', 'findByHash', 'rotate', 'revokeFamily']) {
      expect(typeof (PostgresRefreshTokenStore.prototype as unknown as Record<string, unknown>)[method]).toBe('function')
    }
  })
})
