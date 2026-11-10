import { describe, expect, it, vi } from 'vitest'
import { RefreshTokenService, hashToken, type RefreshTokenRotationResult, type RefreshTokenStore } from '../src/index.ts'

describe('atomic refresh-token service', () => {
  const now = new Date('2026-11-09T00:00:00Z')

  function fixture(result: RefreshTokenRotationResult) {
    const rotate = vi.fn<RefreshTokenStore['rotate']>().mockResolvedValue(result)
    const revokeFamily = vi.fn<RefreshTokenStore['revokeFamily']>().mockResolvedValue(undefined)
    const store: RefreshTokenStore = {
      create: vi.fn<RefreshTokenStore['create']>().mockResolvedValue(undefined),
      rotate,
      revokeFamily,
    }
    return { rotate, revokeFamily, service: new RefreshTokenService(store, () => now, 60_000) }
  }

  it('generates replacement material before the atomic call and returns persisted identity', async () => {
    const { rotate, service } = fixture({ status: 'rotated', id: 'persisted-id', userId: 'user', sessionId: 'session', familyId: 'family' })
    const result = await service.rotate('presented-secret')

    expect(rotate).toHaveBeenCalledOnce()
    const call = rotate.mock.calls[0]
    if (call === undefined) throw new Error('rotation did not call the store')
    const [presentedHash, replacement, timestamp] = call
    expect(presentedHash).toBe(hashToken('presented-secret'))
    expect(timestamp).toBe(now)
    expect(typeof replacement.id).toBe('string')
    expect(typeof replacement.tokenHash).toBe('string')
    expect(replacement.expiresAt).toEqual(new Date(now.getTime() + 60_000))
    expect(result).toMatchObject({ id: 'persisted-id', userId: 'user', sessionId: 'session', familyId: 'family' })
    if (result === null) throw new Error('rotation unexpectedly rejected')
    expect(result.token).not.toBe('presented-secret')
    expect(hashToken(result.token)).toBe(replacement.tokenHash)
  })

  it.each(['invalid', 'reused'] as const)('maps %s to null without a separate revoke decision', async (status) => {
    const { revokeFamily, service } = fixture({ status })
    await expect(service.rotate('presented-secret')).resolves.toBeNull()
    expect(revokeFamily).not.toHaveBeenCalled()
  })

  it('propagates infrastructure failures instead of treating them as invalid credentials', async () => {
    const { rotate, service } = fixture({ status: 'invalid' })
    const error = new Error('database unavailable')
    rotate.mockRejectedValueOnce(error)
    await expect(service.rotate('presented-secret')).rejects.toBe(error)
  })
})
