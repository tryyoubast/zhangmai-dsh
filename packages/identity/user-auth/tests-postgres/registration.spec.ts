/** Registration and email verification through the restricted PostgreSQL auth role. */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken, UserAuthService } from '../src/index.ts'
import { PostgresAuthFixture, testNow } from './fixture.ts'

describe('PostgreSQL registration lifecycle', () => {
  const fixture = new PostgresAuthFixture()
  beforeAll(() => fixture.open())
  afterAll(() => fixture.close())

  it('persists a generated user UUID, consumes verification once, and creates a browser session', async () => {
    const service = new UserAuthService(fixture.firstStore, { now: () => testNow })
    const email = `registration-${randomUUID()}@test.invalid`
    const password = 'a sufficiently long registration password'
    const registration = await service.register(email, password)
    expect(registration.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(await fixture.firstStore.findUserByEmail(email)).toMatchObject({
      id: registration.userId, status: 'pending', emailVerifiedAt: null,
    })
    const verification = await fixture.control.query(`SELECT token_hash,consumed_at
      FROM auth.email_verification_tokens WHERE user_id=$1`, [registration.userId])
    expect(verification.rows).toEqual([{ token_hash: hashToken(registration.verificationToken), consumed_at: null }])
    await expect(service.login(email, password, 'browser')).resolves.toBeNull()
    await expect(service.verifyEmail(registration.verificationToken)).resolves.toBe(true)
    await expect(service.verifyEmail(registration.verificationToken)).resolves.toBe(false)
    expect(await fixture.firstStore.findUserByEmail(email)).toMatchObject({
      id: registration.userId, status: 'active', emailVerifiedAt: testNow,
    })
    const login = await service.login(email, password, 'browser')
    expect(login).toMatchObject({ userId: registration.userId, clientType: 'browser' })
    if (login === null) throw new Error('Verified account did not authenticate')
    const sessions = await fixture.control.query(`SELECT id,user_id,token_hash,client_type
      FROM auth.sessions WHERE user_id=$1`, [registration.userId])
    expect(sessions.rows).toEqual([{
      id: login.sessionId, user_id: registration.userId, token_hash: hashToken(login.sessionToken), client_type: 'web',
    }])
  })
})
