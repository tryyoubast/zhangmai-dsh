import { describe, expect, it } from 'vitest'
import * as authoring from '../src/index.ts'
import { serviceDatabase } from './coverage-fixture.ts'

const active = { workspace_id: 'workspace', role: 'editor', revoked_at: null, workspace_status: 'active' }

function service() {
  expect(authoring).toHaveProperty('PostgresWorkspaceIdentity')
  const db = serviceDatabase()
  return { db, identity: new authoring.PostgresWorkspaceIdentity(db.database) }
}

describe('current PostgreSQL workspace identity', () => {
  it('does not create a workspace while resolving an ordinary request', async () => {
    const { db, identity } = service()
    await expect(identity.resolve('user')).resolves.toBeNull()
    expect(db.writes).toHaveLength(0)
  })

  it('resolves current roles from the database on each request', async () => {
    const { db, identity } = service()
    db.executionReplies.set(5, [active])
    await expect(identity.resolve('user', 'WORKSPACE')).resolves.toEqual({ userId: 'user', workspaceId: 'workspace', roles: ['editor'] })
    db.executionReplies.set(10, [{ ...active, role: 'member' }])
    await expect(identity.resolve('user')).resolves.toEqual({ userId: 'user', workspaceId: 'workspace', roles: ['member'] })
    expect(db.writes).toHaveLength(0)
  })

  it.each(['other', 'not-a-uuid', ''])('rejects an unavailable workspace hint %j without fallback', async (hint) => {
    const { db, identity } = service()
    db.executionReplies.set(5, [active])
    await expect(identity.resolve('user', hint)).resolves.toBeNull()
    expect(db.writes).toHaveLength(0)
  })

  it.each([
    { ...active, revoked_at: new Date() }, { ...active, workspace_status: 'archived' },
    { ...active, workspace_status: 'deleted' },
  ])('retains inaccessible history without creating or restoring a workspace: %j', async (membership) => {
    const { db, identity } = service()
    db.executionReplies.set(6, [membership])
    await expect(identity.onboard('user')).resolves.toBeNull()
    expect(db.writes).toHaveLength(0)
  })

  it('creates the personal workspace and owner membership in one transaction only for empty history', async () => {
    const { db, identity } = service()
    const result = await identity.onboard('user')
    expect(result?.workspaceId).toMatch(/^[\da-f-]{36}$/u)
    expect(result).toEqual({ userId: 'user', workspaceId: result?.workspaceId, roles: ['owner'] })
    expect(db.writes.map(write => write.values)).toEqual([
      { id: result?.workspaceId, ownerUserId: 'user', name: 'Personal workspace', status: 'active' },
      { workspaceId: result?.workspaceId, userId: 'user', role: 'owner' },
    ])
    expect(db.transactions).toBe(1)
  })

  it('returns an existing active membership during onboarding without inserting', async () => {
    const { db, identity } = service()
    db.executionReplies.set(6, [active])
    await expect(identity.onboard('user')).resolves.toEqual({ userId: 'user', workspaceId: 'workspace', roles: ['editor'] })
    expect(db.writes).toHaveLength(0)
  })

  it('uses an archived administrator membership for credentials and explicit restoration only', async () => {
    const { db, identity } = service()
    const archived = { ...active, role: 'admin', workspace_status: 'archived' }
    const expected = { userId: 'user', workspaceId: 'workspace', roles: ['admin'] }
    db.executionReplies.set(5, [archived])
    await expect(identity.resolve('user')).resolves.toBeNull()
    db.executionReplies.set(10, [archived])
    await expect(identity.resolveForCredentials('user')).resolves.toEqual(expected)
    db.executionReplies.set(15, [archived])
    await expect(identity.resolveForRestore('user', 'workspace')).resolves.toEqual(expected)
    db.executionReplies.set(21, [archived])
    await expect(identity.onboard('user')).resolves.toEqual(expected)
    expect(db.writes).toHaveLength(0)
  })

  it('prefers an active workspace for credentials and never falls back from an explicit hint', async () => {
    const { db, identity } = service()
    const rows = [{ ...active, workspace_id: 'earlier', role: 'owner', workspace_status: 'archived' }, active]
    db.executionReplies.set(5, rows)
    await expect(identity.resolveForCredentials('user')).resolves.toMatchObject({ workspaceId: 'workspace' })
    db.executionReplies.set(10, rows)
    await expect(identity.resolveForCredentials('user', 'missing')).resolves.toBeNull()
    db.executionReplies.set(15, [{ ...rows[0], revoked_at: new Date() }])
    await expect(identity.resolveForRestore('user', 'earlier')).resolves.toBeNull()
  })
})
