import { describe, expect, it } from 'vitest'
import { auditEvents, refreshTokens } from '@deepseek-ai/dsh-database-postgres'
import { PostgresAuthStore, type RefreshTokenRecord } from '../src/index.ts'

const now = new Date('2026-11-09T00:00:00Z')
const current: RefreshTokenRecord = {
  id: 'old', userId: 'user', sessionId: 'session', familyId: 'family', tokenHash: 'old-hash',
  expiresAt: new Date(now.getTime() + 60_000), usedAt: null, revokedAt: null,
}
const replacement = { id: 'new', tokenHash: 'new-hash', expiresAt: new Date(now.getTime() + 120_000) }

function fixture(records: unknown[][], rejectAudit = false) {
  const operations: Array<{ kind: string; table?: unknown; value?: unknown }> = []
  let committed = false
  let rolledBack = false
  function query(result: unknown, operation: { kind: string; table?: unknown; value?: unknown }) {
    const promise = Promise.resolve(result)
    const builder = {
      from: (_table: unknown) => builder,
      where: (_condition: unknown) => builder,
      limit: (_count: number) => builder,
      for: (strength: string) => { operations.push({ kind: strength }); return builder },
      groupBy: (_column: unknown) => builder,
      orderBy: (_column: unknown) => builder,
      set: (value: unknown) => { operation.value = value; return builder },
      values: (value: unknown) => { operation.value = value; return builder },
      returning: (_selection: unknown) => builder,
      then: promise.then.bind(promise),
    }
    return builder
  }
  const db = {
    select: (_selection?: unknown) => query(records.shift() ?? [], { kind: 'select' }),
    execute: async (_statement: unknown) => { operations.push({ kind: 'family-lock' }) },
    insert: (table: unknown) => {
      const operation = { kind: 'insert', table }
      operations.push(operation)
      if (table === auditEvents && rejectAudit) throw new Error('audit unavailable')
      return query([], operation)
    },
    update: (table: unknown) => {
      const operation = { kind: 'update', table }
      operations.push(operation)
      return query([{ id: 'old' }], operation)
    },
  }
  const database = {
    db: {
      transaction: async <T>(callback: (transaction: typeof db) => Promise<T>, config: unknown) => {
        operations.push({ kind: 'transaction', value: config })
        try { const result = await callback(db); committed = true; return result }
        catch (error) { rolledBack = true; throw error }
      },
    },
  }
  return { store: new PostgresAuthStore(database as never, () => now), operations, state: () => ({ committed, rolledBack }) }
}

describe('PostgreSQL atomic refresh rotation', () => {
  function withToken(record: RefreshTokenRecord = current, rejectAudit = false) {
    return fixture([[{ userId: 'user', familyId: 'family' }], [{ id: 'user' }], [record]], rejectAudit)
  }

  it('locks user then family then token and inserts before setting replaced_by', async () => {
    const { store, operations, state } = withToken()
    await expect(store.rotate(current.tokenHash, replacement, now)).resolves.toEqual({
      status: 'rotated', id: 'new', userId: 'user', sessionId: 'session', familyId: 'family',
    })
    expect(operations.slice(0, 4)).toEqual([
      { kind: 'transaction', value: { isolationLevel: 'read committed' } },
      { kind: 'key share' }, { kind: 'family-lock' }, { kind: 'update' },
    ])
    expect(operations.slice(4)).toEqual([
      { kind: 'insert', table: refreshTokens, value: { ...replacement, userId: 'user', sessionId: 'session', familyId: 'family', usedAt: null, revokedAt: null } },
      { kind: 'update', table: refreshTokens, value: { usedAt: now, replacedBy: replacement.id } },
    ])
    expect(state()).toEqual({ committed: true, rolledBack: false })
  })

  it('rejects unknown hashes without taking locks or writing', async () => {
    const { store, operations } = fixture([[]])
    await expect(store.rotate('unknown', replacement, now)).resolves.toEqual({ status: 'invalid' })
    expect(operations).toEqual([{ kind: 'transaction', value: { isolationLevel: 'read committed' } }])
  })

  it('returns invalid when the located user no longer exists', async () => {
    const { store, operations } = fixture([[{ userId: 'user', familyId: 'family' }], []])
    await expect(store.rotate(current.tokenHash, replacement, now)).resolves.toEqual({ status: 'invalid' })
    expect(operations.map(operation => operation.kind)).toEqual(['transaction', 'key share'])
  })

  it('returns invalid when a token disappears before the locked read', async () => {
    const { store } = fixture([[{ userId: 'user', familyId: 'family' }], [{ id: 'user' }], []])
    await expect(store.rotate(current.tokenHash, replacement, now)).resolves.toEqual({ status: 'invalid' })
  })

  it.each([
    { ...current, revokedAt: now },
    { ...current, expiresAt: now },
  ])('rejects an ineligible token without replacement or audit', async (record) => {
    const { store, operations } = withToken(record)
    await expect(store.rotate(current.tokenHash, replacement, now)).resolves.toEqual({ status: 'invalid' })
    expect(operations.filter(operation => operation.table !== undefined)).toEqual([])
  })

  it('revokes the family and writes only the specified replay audit fields', async () => {
    const { store, operations } = withToken({ ...current, usedAt: now })
    await expect(store.rotate(current.tokenHash, replacement, now)).resolves.toEqual({ status: 'reused' })
    expect(operations.slice(4)).toEqual([
      { kind: 'update', table: refreshTokens, value: { revokedAt: now } },
      { kind: 'insert', table: auditEvents, value: {
        workspaceId: null, actorType: 'system', actorId: 'auth.refresh_token_service',
        action: 'auth.refresh_token_reuse_detected', targetType: 'refresh_token_family', targetId: 'family',
        metadata: { userId: 'user', sessionId: 'session', tokenId: 'old' }, createdAt: now,
      } },
    ])
  })

  it('rejects and rolls back when the replay audit cannot be appended', async () => {
    const { store, state } = withToken({ ...current, usedAt: now }, true)
    await expect(store.rotate(current.tokenHash, replacement, now)).rejects.toThrow('audit unavailable')
    expect(state()).toEqual({ committed: false, rolledBack: true })
  })

  it('uses the same user and family locks when creating the first token', async () => {
    const { store, operations } = fixture([[{ id: 'user' }]])
    await store.create(current)
    expect(operations).toEqual([
      { kind: 'transaction', value: { isolationLevel: 'read committed' } },
      { kind: 'key share' }, { kind: 'family-lock' },
      { kind: 'insert', table: refreshTokens, value: current },
    ])
  })

  it('rejects initial issuance for a missing user without inserting a token', async () => {
    const { store, operations } = fixture([[]])
    await expect(store.create(current)).rejects.toThrow('refresh token owner does not exist')
    expect(operations.some(operation => operation.kind === 'insert')).toBe(false)
  })

  it('takes the same locks before explicitly revoking a family', async () => {
    const { store, operations } = fixture([[{ userId: 'user' }], [{ id: 'user' }]])
    await store.revokeFamily('family')
    expect(operations).toEqual([
      { kind: 'transaction', value: { isolationLevel: 'read committed' } },
      { kind: 'key share' }, { kind: 'family-lock' },
      { kind: 'update', table: refreshTokens, value: { revokedAt: now } },
    ])
  })

  it('leaves missing families unchanged', async () => {
    const { store, operations } = fixture([[]])
    await store.revokeFamily('missing')
    expect(operations).toEqual([{ kind: 'transaction', value: { isolationLevel: 'read committed' } }])
  })

  it('locks the user exclusively before locking families and resetting credentials', async () => {
    const { store, operations } = fixture([[{ id: 'user' }], [{ familyId: 'first' }, { familyId: 'second' }]])
    await store.resetPassword('user', 'new-password-hash', now)
    expect(operations.map(operation => operation.kind)).toEqual([
      'transaction', 'update', 'family-lock', 'family-lock', 'update', 'update', 'update',
    ])
    expect(operations[0]?.value).toEqual({ isolationLevel: 'read committed' })
  })
})
