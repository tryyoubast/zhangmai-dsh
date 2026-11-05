import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AuthHttpController, UserAuthService } from '../src/index.ts'
import { withFixture } from './fixture.ts'

describe('PostgreSQL refresh-token concurrency', () => {
  it('revokes the newly inserted descendant when an older generation is replayed during rotation', async () => {
    await withFixture(async (fixture) => {
      const t0 = await fixture.token()
      const t1 = fixture.replacement()
      await expect(fixture.first.rotate(t0.tokenHash, t1, fixture.now)).resolves.toMatchObject({ status: 'rotated' })
      const t2 = fixture.replacement()
      const release = await fixture.gate(t1.id)
      const rotation = fixture.track(fixture.first.rotate(t1.tokenHash, t2, fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const replay = fixture.track(fixture.second.rotate(t0.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()
      await expect(rotation).resolves.toMatchObject({ status: 'rotated' })
      await expect(replay).resolves.toEqual({ status: 'reused' })

      const tokens = await fixture.tokens()
      expect(tokens).toHaveLength(3)
      expect(tokens.find(token => token.id === t2.id),
        'the descendant inserted before replay must be revoked after both transactions commit').toMatchObject({
        id: t2.id, revoked_at: fixture.now,
      })
      expect(tokens.every(token => token.revoked_at !== null)).toBe(true)
      await fixture.audit(t0.id)
      await expect(fixture.first.rotate(t2.tokenHash, fixture.replacement(), fixture.now)).resolves.toEqual({ status: 'invalid' })
      expect(await fixture.tokens()).toHaveLength(3)
    })
  })

  it('rotates one unused token once and revokes the winner when the competing request reuses it', async () => {
    await withFixture(async (fixture) => {
      const original = await fixture.token()
      const winner = fixture.replacement()
      const loser = fixture.replacement()
      const release = await fixture.gate(original.id)
      const first = fixture.track(fixture.first.rotate(original.tokenHash, winner, fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const second = fixture.track(fixture.second.rotate(original.tokenHash, loser, fixture.now))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()
      await expect(first).resolves.toMatchObject({ status: 'rotated', id: winner.id })
      await expect(second).resolves.toEqual({ status: 'reused' })
      const tokens = await fixture.tokens()
      expect(tokens).toHaveLength(2)
      expect(tokens.every(token => token.revoked_at !== null)).toBe(true)
      expect(tokens.find(token => token.id === original.id)).toMatchObject({ replaced_by: winner.id, used_at: fixture.now })
      expect(tokens.some(token => token.id === loser.id)).toBe(false)
      await fixture.audit(original.id)
      await expect(fixture.first.rotate(winner.tokenHash, fixture.replacement(), fixture.now)).resolves.toEqual({ status: 'invalid' })
      expect(await fixture.tokens()).toHaveLength(2)
    })
  })

  it('rejects descendant rotation when replay acquires the family first', async () => {
    await withFixture(async (fixture) => {
      const t0 = await fixture.token()
      const t1 = fixture.replacement()
      await fixture.first.rotate(t0.tokenHash, t1, fixture.now)
      const release = await fixture.gate(t0.id, 'revoked')
      const replay = fixture.track(fixture.first.rotate(t0.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const rotation = fixture.track(fixture.second.rotate(t1.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()
      await expect(replay).resolves.toEqual({ status: 'reused' })
      await expect(rotation).resolves.toEqual({ status: 'invalid' })
      const tokens = await fixture.tokens()
      expect(tokens).toHaveLength(2)
      expect(tokens.every(token => token.revoked_at !== null)).toBe(true)
      await fixture.audit(t0.id)
    })
  })

  it('serializes replay of different used generations without deadlock or duplicate audit', async () => {
    await withFixture(async (fixture) => {
      const t0 = await fixture.token()
      const t1 = fixture.replacement()
      const t2 = fixture.replacement()
      await fixture.first.rotate(t0.tokenHash, t1, fixture.now)
      await fixture.first.rotate(t1.tokenHash, t2, fixture.now)
      const release = await fixture.gate(t0.id, 'revoked')
      const firstReplay = fixture.track(fixture.first.rotate(t0.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const secondReplay = fixture.track(fixture.second.rotate(t1.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()
      await expect(firstReplay).resolves.toEqual({ status: 'reused' })
      await expect(secondReplay).resolves.toEqual({ status: 'invalid' })
      const tokens = await fixture.tokens()
      expect(tokens).toHaveLength(3)
      expect(tokens.every(token => token.revoked_at !== null)).toBe(true)
      await fixture.audit(t0.id)
    })
  })

  it('revokes the in-flight replacement when revokeFamily receives the uppercase family UUID', async () => {
    await withFixture(async (fixture) => {
      const original = await fixture.token()
      const winner = fixture.replacement()
      const release = await fixture.gate(original.id)
      const rotation = fixture.track(fixture.first.rotate(original.tokenHash, winner, fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const revocation = fixture.track(fixture.second.revokeFamily(fixture.familyId.toUpperCase()))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()
      await expect(rotation).resolves.toMatchObject({ status: 'rotated', id: winner.id })
      await expect(revocation).resolves.toBeUndefined()
      const tokens = await fixture.tokens()
      expect(tokens).toHaveLength(2)
      expect(tokens.every(token => token.revoked_at !== null)).toBe(true)
      await fixture.audit(original.id, 0)
      await expect(fixture.first.rotate(winner.tokenHash, fixture.replacement(), fixture.now)).resolves.toEqual({ status: 'invalid' })
    })
  })

  it('allows a different family to rotate while the first family is gated', async () => {
    await withFixture(async (fixture) => {
      const firstToken = await fixture.token()
      const secondToken = await fixture.token(randomUUID())
      const release = await fixture.gate(firstToken.id)
      const firstRotation = fixture.track(fixture.first.rotate(firstToken.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const secondRotation = fixture.track(fixture.second.rotate(secondToken.tokenHash, fixture.replacement(), fixture.now))
      await expect(secondRotation).resolves.toMatchObject({ status: 'rotated', familyId: secondToken.familyId })
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      expect((await fixture.tokens(secondToken.familyId)).every(token => token.revoked_at === null)).toBe(true)
      await release()
      await expect(firstRotation).resolves.toMatchObject({ status: 'rotated', familyId: firstToken.familyId })
      expect(await fixture.tokens()).toHaveLength(2)
      expect(await fixture.tokens(secondToken.familyId)).toHaveLength(2)
      await fixture.audit(firstToken.id, 0)
    })
  })

  it('serializes password reset before revoking refresh tokens against a concurrent rotation', async () => {
    await withFixture(async (fixture) => {
      const original = await fixture.token()
      const release = await fixture.gate(original.id, 'revoked')
      const reset = fixture.track(fixture.first.resetPassword(fixture.userId, 'new-password-hash', fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const rotation = fixture.track(fixture.second.rotate(original.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()

      await expect(reset).resolves.toBeUndefined()
      await expect(rotation).resolves.toEqual({ status: 'invalid' })
      const tokens = await fixture.tokens()
      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toMatchObject({ id: original.id, revoked_at: fixture.now })
    })
  })

  it('rolls back family revocation on audit-insert failure and releases its lock to a waiting rotation', async () => {
    await withFixture(async (fixture) => {
      const t0 = await fixture.token()
      const t1 = fixture.replacement()
      const t2 = fixture.replacement()
      await fixture.first.rotate(t0.tokenHash, t1, fixture.now)
      const restoreAudit = await fixture.failAudit()
      const release = await fixture.gate(t0.id, 'revoked')
      const failedReplay = fixture.track(fixture.first.rotate(t0.tokenHash, fixture.replacement(), fixture.now))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const rotation = fixture.track(fixture.second.rotate(t1.tokenHash, t2, fixture.now))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()
      await expect(failedReplay).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'fixture audit insert failed' }) })
      await expect(rotation).resolves.toMatchObject({ status: 'rotated', id: t2.id })
      const tokens = await fixture.tokens()
      expect(tokens).toHaveLength(3)
      expect(tokens.every(token => token.revoked_at === null)).toBe(true)
      expect(tokens.find(token => token.id === t0.id)).toMatchObject({ replaced_by: t1.id })
      expect(tokens.find(token => token.id === t1.id)).toMatchObject({ replaced_by: t2.id, used_at: fixture.now })
      await fixture.audit(t0.id, 0)
      await restoreAudit()
      await expect(fixture.first.rotate(t0.tokenHash, fixture.replacement(), fixture.now)).resolves.toEqual({ status: 'reused' })
      expect((await fixture.tokens()).every(token => token.revoked_at !== null)).toBe(true)
      await fixture.audit(t0.id)
    })
  })

  it('returns HTTP 200 and 401 for concurrent real-store refreshes and rejects the winner after reuse', async () => {
    await withFixture(async (fixture) => {
      const original = await fixture.token()
      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      const controllers = [fixture.first, fixture.second].map(store => new AuthHttpController(new UserAuthService(store), store, {
        now: () => fixture.now,
        accessToken: { privateKey, publicKey, issuer: 'dsh', audience: 'dsh-api' },
        sessionResolver: {
          findSessionByTokenHash: tokenHash => store.findSessionByTokenHash(tokenHash),
          findSessionById: sessionId => store.findSessionById(sessionId),
          revokeSession: sessionId => store.revokeSession(sessionId),
        },
        resolveIdentity: async userId => ({ userId, workspaceId: randomUUID(), roles: ['owner'] }),
      }))
      const request = (refreshToken: string) => ({
        method: 'POST', path: '/api/auth/refresh', headers: {}, body: { refreshToken },
      })
      const release = await fixture.gate(original.id)
      const first = fixture.track(controllers[0]!.handle(request(original.raw)))
      await fixture.blocked(fixture.firstPid, fixture.controlPid)
      const second = fixture.track(controllers[1]!.handle(request(original.raw)))
      await fixture.blocked(fixture.secondPid, fixture.firstPid)
      await release()
      const winner = await first
      const replay = await second
      expect(winner.status).toBe(200)
      expect(replay.status).toBe(401)
      expect(JSON.parse(replay.body)).toEqual({ error: 'invalid_refresh_token' })
      const winnerToken: unknown = JSON.parse(winner.body).refreshToken
      expect(typeof winnerToken).toBe('string')
      if (typeof winnerToken !== 'string') throw new Error('HTTP refresh response omitted replacement token')
      const rejectedWinner = await controllers[0]!.handle(request(winnerToken))
      expect(rejectedWinner.status).toBe(401)
      expect(JSON.parse(rejectedWinner.body)).toEqual({ error: 'invalid_refresh_token' })
      expect(await fixture.tokens()).toHaveLength(2)
      expect((await fixture.tokens()).every(token => token.revoked_at !== null)).toBe(true)
      await fixture.audit(original.id)
    })
  })

  it.each(['unknown', 'expired', 'revoked'] as const)('returns invalid for a %s token without durable writes', async (kind) => {
    await withFixture(async (fixture) => {
      const original = await fixture.token()
      if (kind === 'expired') {
        await fixture.migrator!.query('UPDATE auth.refresh_tokens SET expires_at = $1 WHERE id = $2', [fixture.now, original.id])
      } else if (kind === 'revoked') {
        await fixture.migrator!.query('UPDATE auth.refresh_tokens SET revoked_at = $1 WHERE id = $2', [fixture.now, original.id])
      }
      const before = await fixture.migrator!.query('SELECT * FROM auth.refresh_tokens WHERE family_id = $1', [fixture.familyId])
      const tokenHash = kind === 'unknown' ? fixture.replacement().tokenHash : original.tokenHash
      await expect(fixture.first.rotate(tokenHash, fixture.replacement(), fixture.now)).resolves.toEqual({ status: 'invalid' })
      const after = await fixture.migrator!.query('SELECT * FROM auth.refresh_tokens WHERE family_id = $1', [fixture.familyId])
      expect(after.rows).toEqual(before.rows)
      await fixture.audit(original.id, 0)
    })
  })
})
