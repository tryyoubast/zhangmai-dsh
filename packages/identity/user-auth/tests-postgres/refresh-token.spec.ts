/** Persistent refresh-token state under real PostgreSQL constraints and overlapping transactions. */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken, PostgresAuthFixture, testExpiry, testNow, type MutationBarrier } from './fixture.ts'
import { postgresTestEnvironment } from './environment.ts'
import { provisionPostgresTestDatabase } from './provision.ts'

type Credential = { token: string; id: string; familyId: string }

function replacement() {
  return { id: randomUUID(), tokenHash: hashToken(randomUUID()), expiresAt: testExpiry }
}

async function overlap<First extends Promise<unknown>, Second extends Promise<unknown>>(
  fixture: PostgresAuthFixture,
  barrier: MutationBarrier,
  firstOperation: () => First,
  secondOperation: () => Second,
  familyId: string,
) {
  const pending: Array<Promise<unknown>> = []
  try {
    const first = firstOperation()
    // Attach rejection handling at acquisition so a failed transaction cannot escape while the lock observer runs.
    pending.push(Promise.allSettled([first]))
    await fixture.waitFor('first operation reached its mutation barrier', () => fixture.blocked(fixture.applicationNames[0], true))
    const second = secondOperation()
    pending.push(Promise.allSettled([second]))
    await fixture.waitFor('second operation overlaps the blocked first operation', () => fixture.blocked(fixture.applicationNames[1]))
    const secondWaitsForFamily = await fixture.waitingForFamily(fixture.applicationNames[1], familyId)
    await barrier.release()
    return { results: await Promise.allSettled([first, second] as const), secondWaitsForFamily }
  } finally {
    await barrier.release()
    await Promise.allSettled(pending)
    await barrier.dispose()
  }
}

function fulfilled<Value>(result: PromiseSettledResult<Value> | undefined): Value {
  expect(result?.status).toBe('fulfilled')
  if (result?.status !== 'fulfilled') throw new Error('Expected a committed operation', { cause: result })
  return result.value
}

async function rotated(fixture: PostgresAuthFixture, token: string): Promise<Credential> {
  const result = await fixture.firstService.rotate(token)
  expect(result).not.toBeNull()
  if (result === null) throw new Error('Expected a usable token')
  return result
}

async function expectRevoked(fixture: PostgresAuthFixture, familyId: string, count: number): Promise<void> {
  const rows = await fixture.tokens(familyId)
  expect(rows).toHaveLength(count)
  expect(rows.every(row => row.revoked_at?.getTime() === testNow.getTime())).toBe(true)
}

async function expectAudit(fixture: PostgresAuthFixture, initial: Credential, userId: string, sessionId: string): Promise<void> {
  expect(await fixture.audits(initial.familyId)).toEqual([{
    workspace_id: null,
    actor_type: 'system',
    actor_id: 'auth.refresh_token_service',
    action: 'auth.refresh_token_reuse_detected',
    target_type: 'refresh_token_family',
    target_id: initial.familyId,
    metadata: { userId, sessionId, tokenId: initial.id },
  }])
}

describe('PostgreSQL refresh-token rotation', () => {
  const fixture = new PostgresAuthFixture()
  beforeAll(() => fixture.open())
  afterAll(() => fixture.close())

  it('runs application queries only as the restricted auth role and control queries only as migrator', async () => {
    const runtime = await fixture.first.db.execute(`SELECT current_user,login.rolsuper,login.rolbypassrls,
      ARRAY(SELECT inherited.rolname::text FROM pg_roles inherited WHERE inherited.rolname <> session_user
        AND pg_has_role(session_user,inherited.oid,'MEMBER')) AS memberships
      FROM pg_roles login WHERE login.rolname=session_user`)
    expect(runtime.rows).toEqual([{ current_user: 'dsh_auth_runtime', rolsuper: false, rolbypassrls: false, memberships: ['dsh_auth_runtime'] }])
    const control = await fixture.control.query(`SELECT current_user,login.rolsuper,login.rolbypassrls,
      ARRAY(SELECT inherited.rolname::text FROM pg_roles inherited WHERE inherited.rolname <> session_user
        AND pg_has_role(session_user,inherited.oid,'MEMBER')) AS memberships
      FROM pg_roles login WHERE login.rolname=session_user`)
    expect(control.rows).toEqual([{ current_user: 'dsh_migrator', rolsuper: false, rolbypassrls: false, memberships: ['dsh_migrator'] }])
  })

  it('rejects a non-superuser bootstrap before changing database objects', async () => {
    const config = postgresTestEnvironment()
    await expect(provisionPostgresTestDatabase({
      DATABASE_TEST_URL: config.runtimeUrl, DATABASE_MIGRATION_URL: config.migrationUrl,
      TEST_DATABASE_BOOTSTRAP_URL: config.runtimeUrl,
    })).rejects.toThrow('bootstrap requires a PostgreSQL superuser login')
    expect((await fixture.control.query('SELECT count(*)::integer AS total FROM drizzle.__drizzle_migrations')).rows).toEqual([{ total: 14 }])
  })

  it('settles simultaneous use of one token as one rotation and one reuse without rejection', async () => {
    const { userId, sessionId } = await fixture.seed()
    const initial = await fixture.family(userId, sessionId)
    const { results, secondWaitsForFamily } = await overlap(
      fixture, await fixture.barrier('auth.refresh_tokens', initial.id),
      () => fixture.firstService.rotate(initial.token), () => fixture.secondService.rotate(initial.token), initial.familyId,
    )
    const first = fulfilled(results[0])
    expect(first).not.toBeNull()
    expect(fulfilled(results[1])).toBeNull()
    await expectRevoked(fixture, initial.familyId, 2)
    expect(secondWaitsForFamily).toBe(true)
    await expectAudit(fixture, initial, userId, sessionId)
    if (first !== null) await expect(fixture.firstService.rotate(first.token)).resolves.toBeNull()
    expect(await fixture.audits(initial.familyId)).toHaveLength(1)
  })

  it('returns the committed rotated and reused store outcomes for one contested token', async () => {
    const { userId, sessionId } = await fixture.seed()
    const initial = await fixture.family(userId, sessionId)
    const firstReplacement = replacement()
    const secondReplacement = replacement()
    const { results, secondWaitsForFamily } = await overlap(
      fixture, await fixture.barrier('auth.refresh_tokens', initial.id),
      () => fixture.firstStore.rotate(hashToken(initial.token), firstReplacement, testNow),
      () => fixture.secondStore.rotate(hashToken(initial.token), secondReplacement, testNow), initial.familyId,
    )
    expect(secondWaitsForFamily).toBe(true)
    expect(fulfilled(results[0])).toEqual({ status: 'rotated', id: firstReplacement.id, userId, sessionId, familyId: initial.familyId })
    expect(fulfilled(results[1])).toEqual({ status: 'reused' })
    const rows = await fixture.tokens(initial.familyId)
    expect(rows.map(row => row.id).sort()).toEqual([initial.id, firstReplacement.id].sort())
    expect(rows.find(row => row.id === initial.id)?.replaced_by).toBe(firstReplacement.id)
    expect(rows.find(row => row.id === initial.id)?.used_at).toEqual(testNow)
    await expectRevoked(fixture, initial.familyId, 2)
    await expectAudit(fixture, initial, userId, sessionId)
  })

  for (const firstOperation of ['descendant rotation', 'ancestor replay'] as const) {
    it(`serializes ancestor replay with descendant rotation when ${firstOperation} acquires the family first`, async () => {
      const { userId, sessionId } = await fixture.seed()
      const initial = await fixture.family(userId, sessionId)
      const descendant = await rotated(fixture, initial.token)
      const unrelated = await fixture.family(userId, sessionId)
      const unrelatedBefore = await fixture.tokens(unrelated.familyId)
      const rotateFirst = firstOperation === 'descendant rotation'
      const { results, secondWaitsForFamily } = await overlap(
        fixture, await fixture.barrier('auth.refresh_tokens', rotateFirst ? descendant.id : initial.id),
        () => fixture.firstService.rotate(rotateFirst ? descendant.token : initial.token),
        () => fixture.secondService.rotate(rotateFirst ? initial.token : descendant.token), initial.familyId,
      )
      const first = fulfilled(results[0])
      const second = fulfilled(results[1])
      expect(second).toBeNull()
      if (rotateFirst) expect(first).not.toBeNull()
      else expect(first).toBeNull()
      await expectRevoked(fixture, initial.familyId, rotateFirst ? 3 : 2)
      expect(secondWaitsForFamily).toBe(true)
      await expectAudit(fixture, initial, userId, sessionId)
      expect(await fixture.tokens(unrelated.familyId)).toEqual(unrelatedBefore)
      if (first !== null) await expect(fixture.firstService.rotate(first.token)).resolves.toBeNull()
      await expect(fixture.firstService.rotate(descendant.token)).resolves.toBeNull()
      expect(await fixture.audits(initial.familyId)).toHaveLength(1)
    })
  }

  for (const firstOperation of ['rotation', 'explicit revocation'] as const) {
    it(`serializes explicit family revocation with ${firstOperation} first`, async () => {
      const { userId, sessionId } = await fixture.seed()
      const initial = await fixture.family(userId, sessionId)
      const unrelated = await fixture.family(userId, sessionId)
      const unrelatedBefore = await fixture.tokens(unrelated.familyId)
      const rotateFirst = firstOperation === 'rotation'
      const { results, secondWaitsForFamily } = await overlap(
        fixture, await fixture.barrier('auth.refresh_tokens', initial.id),
        () => rotateFirst ? fixture.firstService.rotate(initial.token) : fixture.firstService.revokeFamily(initial.familyId),
        () => rotateFirst ? fixture.secondService.revokeFamily(initial.familyId) : fixture.secondService.rotate(initial.token),
        initial.familyId,
      )
      expect(secondWaitsForFamily).toBe(true)
      const first = fulfilled(results[0])
      const second = fulfilled(results[1])
      if (rotateFirst) {
        expect(first).toMatchObject({ familyId: initial.familyId, userId, sessionId })
        expect(second).toBeUndefined()
        if (first) await expect(fixture.firstService.rotate(first.token)).resolves.toBeNull()
      } else {
        expect(first).toBeUndefined()
        expect(second).toBeNull()
      }
      await expectRevoked(fixture, initial.familyId, rotateFirst ? 2 : 1)
      expect(await fixture.tokens(unrelated.familyId)).toEqual(unrelatedBefore)
      expect(await fixture.audits(initial.familyId)).toHaveLength(0)
    })
  }

  for (const firstOperation of ['rotation', 'password reset'] as const) {
    it(`serializes password reset with ${firstOperation} first and revokes every session and family`, async () => {
      const { userId, sessionId } = await fixture.seed()
      const initial = await fixture.family(userId, sessionId)
      const secondSessionId = await fixture.session(userId)
      const otherFamily = await fixture.family(userId, secondSessionId)
      const unrelatedUser = await fixture.seed()
      const unrelatedFamily = await fixture.family(unrelatedUser.userId, unrelatedUser.sessionId)
      const unrelatedBefore = await fixture.tokens(unrelatedFamily.familyId)
      const rotateFirst = firstOperation === 'rotation'
      const { results, secondWaitsForFamily } = await overlap(
        fixture, await fixture.barrier(rotateFirst ? 'auth.refresh_tokens' : 'auth.users', rotateFirst ? initial.id : userId),
        () => rotateFirst ? fixture.firstService.rotate(initial.token) : fixture.firstStore.resetPassword(userId, 'new-password', testNow),
        () => rotateFirst ? fixture.secondStore.resetPassword(userId, 'new-password', testNow) : fixture.secondService.rotate(initial.token), initial.familyId,
      )
      // Reset and refresh coordinate on the user row before either operation can lock families.
      expect(secondWaitsForFamily).toBe(false)
      const first = fulfilled(results[0])
      const second = fulfilled(results[1])
      if (rotateFirst) {
        expect(first).toMatchObject({ familyId: initial.familyId })
        expect(second).toBeUndefined()
        if (first) await expect(fixture.firstService.rotate(first.token)).resolves.toBeNull()
      } else {
        expect(first).toBeUndefined()
        expect(second).toBeNull()
      }
      await expectRevoked(fixture, initial.familyId, rotateFirst ? 2 : 1)
      await expectRevoked(fixture, otherFamily.familyId, 1)
      const user = await fixture.control.query('SELECT password_hash,password_changed_at FROM auth.users WHERE id=$1', [userId])
      expect(user.rows).toEqual([{ password_hash: 'new-password', password_changed_at: testNow }])
      const sessions = await fixture.control.query('SELECT revoked_at FROM auth.sessions WHERE user_id=$1', [userId])
      expect(sessions.rows).toEqual([{ revoked_at: testNow }, { revoked_at: testNow }])
      expect(await fixture.tokens(unrelatedFamily.familyId)).toEqual(unrelatedBefore)
      expect(await fixture.audits(initial.familyId)).toHaveLength(0)
      expect(await fixture.audits(otherFamily.familyId)).toHaveLength(0)
    })
  }

  for (const state of ['unknown', 'expired', 'expiry equals now', 'revoked', 'expired and used', 'revoked and used'] as const) {
    it(`rejects ${state} credentials without any token or audit writes`, async () => {
      const { userId, sessionId } = await fixture.seed()
      const initial = await fixture.family(userId, sessionId)
      if (state.includes('expired') || state === 'expiry equals now') {
        await fixture.control.query('UPDATE auth.refresh_tokens SET expires_at=$2 WHERE id=$1', [initial.id,
          state === 'expiry equals now' ? testNow : new Date(testNow.getTime() - 1)])
      }
      if (state.includes('revoked')) await fixture.control.query('UPDATE auth.refresh_tokens SET revoked_at=$2 WHERE id=$1', [initial.id, testNow])
      if (state.includes('used')) await fixture.control.query('UPDATE auth.refresh_tokens SET used_at=$2 WHERE id=$1', [initial.id, testNow])
      const before = await fixture.tokens(initial.familyId)
      const next = replacement()
      await expect(fixture.firstStore.rotate(state === 'unknown' ? hashToken(randomUUID()) : hashToken(initial.token), next, testNow))
        .resolves.toEqual({ status: 'invalid' })
      expect(await fixture.tokens(initial.familyId)).toEqual(before)
      expect((await fixture.control.query('SELECT id FROM auth.refresh_tokens WHERE id=$1', [next.id])).rows).toHaveLength(0)
      expect(await fixture.audits(initial.familyId)).toHaveLength(0)
    })
  }

  it('rolls back all family revocations when the mandatory replay audit insert fails', async () => {
    const { userId, sessionId } = await fixture.seed()
    const initial = await fixture.family(userId, sessionId)
    const child = await rotated(fixture, initial.token)
    const grandchild = await rotated(fixture, child.token)
    const before = await fixture.tokens(initial.familyId)
    const next = replacement()
    const dispose = await fixture.rejectAudit(initial.familyId)
    try {
      await expect(fixture.firstStore.rotate(hashToken(initial.token), next, testNow)).rejects.toMatchObject({
        cause: { message: 'injected audit insert failure' },
      })
      expect(await fixture.tokens(initial.familyId)).toEqual(before)
      expect(await fixture.audits(initial.familyId)).toHaveLength(0)
      expect((await fixture.control.query('SELECT id FROM auth.refresh_tokens WHERE id=$1', [next.id])).rows).toHaveLength(0)
    } finally {
      await dispose()
    }
    const active = await rotated(fixture, grandchild.token)
    await expect(fixture.firstService.rotate(initial.token)).resolves.toBeNull()
    await expectRevoked(fixture, initial.familyId, 4)
    await expectAudit(fixture, initial, userId, sessionId)
    await expect(fixture.firstService.rotate(active.token)).resolves.toBeNull()
  })
})
