import type { RefreshTokenRecord, RefreshTokenReplacement, RefreshTokenRotationResult, RefreshTokenStore } from '../src/index.ts'

export class MemoryRefreshTokenStore implements RefreshTokenStore {
  readonly records = new Map<string, RefreshTokenRecord>()
  readonly revokedFamilies: string[] = []

  create(record: RefreshTokenRecord): Promise<void> {
    this.records.set(record.tokenHash, record)
    return Promise.resolve()
  }

  rotate(tokenHash: string, replacement: RefreshTokenReplacement, now: Date): Promise<RefreshTokenRotationResult> {
    const current = this.records.get(tokenHash)
    if (current === undefined || current.revokedAt !== null || current.expiresAt <= now) return Promise.resolve({ status: 'invalid' })
    if (current.usedAt !== null) {
      this.revoke(current.familyId, now)
      return Promise.resolve({ status: 'reused' })
    }
    this.records.set(replacement.tokenHash, { ...current, ...replacement, usedAt: null, revokedAt: null })
    this.records.set(tokenHash, { ...current, usedAt: now })
    return Promise.resolve({ status: 'rotated', id: replacement.id, userId: current.userId, sessionId: current.sessionId, familyId: current.familyId })
  }

  revokeFamily(familyId: string): Promise<void> {
    this.revoke(familyId, new Date())
    return Promise.resolve()
  }

  private revoke(familyId: string, now: Date): void {
    this.revokedFamilies.push(familyId)
    for (const [hash, record] of this.records) {
      if (record.familyId === familyId && record.revokedAt === null) this.records.set(hash, { ...record, revokedAt: now })
    }
  }
}
