/** Resolve current membership authority and initialize first-login personal workspaces under application RLS. */
import { randomUUID } from 'node:crypto'
import {
  sql, workspaceMembers, workspaces, withRequestContext,
  type DatabaseClient, type DshDatabase,
} from '@deepseek-ai/dsh-database-postgres'
import type { AuthHttpIdentity, WorkspaceRole } from '@deepseek-ai/dsh-user-auth'

interface MembershipRow extends Record<string, unknown> {
  readonly workspace_id: string
  readonly role: WorkspaceRole
  readonly revoked_at: Date | null
  readonly workspace_status: string
}

async function memberships(database: DshDatabase): Promise<readonly MembershipRow[]> {
  const result = await database.execute<MembershipRow>(sql`SELECT * FROM app.current_user_workspace_memberships()`)
  return result.rows
}

function identityFromMemberships(userId: string, rows: readonly MembershipRow[], workspaceHint?: string, status: 'active' | 'archived' = 'active'): AuthHttpIdentity | null {
  const member = rows.find(row => row.revoked_at === null && row.workspace_status === status
    && (status === 'active' || row.role === 'owner' || row.role === 'admin')
    && (workspaceHint === undefined || row.workspace_id === workspaceHint.toLowerCase()))
  return member === undefined ? null : { userId, workspaceId: member.workspace_id, roles: [member.role] }
}

function credentialsIdentity(userId: string, rows: readonly MembershipRow[], workspaceHint?: string): AuthHttpIdentity | null {
  return identityFromMemberships(userId, rows, workspaceHint) ?? identityFromMemberships(userId, rows, workspaceHint, 'archived')
}

/**
 * Read workspace authority from PostgreSQL for users already authenticated by the session resolver.
 * The caller owns session validation; this service never authenticates a session or accepts request-supplied roles.
 * Requires a database connected exclusively as dsh_app_runtime.
 */
export class PostgresWorkspaceIdentity {
  constructor(private readonly database: DatabaseClient<DshDatabase>) {}

  /**
   * Resolve a current active membership without creating or restoring workspace data.
   * @param userId - User ID established by the trusted authentication/session resolver.
   * @param workspaceHint - Optional workspace selection; an inaccessible or malformed hint returns null without fallback.
   * @returns Current database roles and workspace, or null when no active membership matches; database failures reject.
   */
  async resolve(userId: string, workspaceHint?: string): Promise<AuthHttpIdentity | null> {
    return withRequestContext(this.database, { userId, workspaceId: '', actorType: 'user' }, async database =>
      identityFromMemberships(userId, await memberships(database), workspaceHint))
  }

  /**
   * Resolve identity for authentication endpoints that can return credentials or session information.
   * @param userId - User ID established by a trusted login or session resolver.
   * @param workspaceHint - Optional exact workspace selection.
   * @returns Current active membership, or an archived owner or admin membership eligible for explicit restoration.
   */
  async resolveForCredentials(userId: string, workspaceHint?: string): Promise<AuthHttpIdentity | null> {
    return withRequestContext(this.database, { userId, workspaceId: '', actorType: 'user' }, async database =>
      credentialsIdentity(userId, await memberships(database), workspaceHint))
  }

  /**
   * Resolve an archived workspace's administrator for its explicit restore request only.
   * @param userId - User ID established by the trusted session resolver.
   * @param workspaceId - Exact workspace targeted by the restore route.
   * @returns A current owner or admin identity for that archived workspace, or null.
   */
  async resolveForRestore(userId: string, workspaceId: string): Promise<AuthHttpIdentity | null> {
    return withRequestContext(this.database, { userId, workspaceId: '', actorType: 'user' }, async database =>
      identityFromMemberships(userId, await memberships(database), workspaceId, 'archived'))
  }

  /**
   * Initialize a personal workspace only when the authenticated user has no historical memberships.
   * A transaction-scoped user lock serializes concurrent first logins; revoked or inactive history prevents recreation.
   * @param userId - User ID returned by a successful trusted login operation.
   * @returns An identity for credentials after commit, or null for inaccessible history; all writes roll back on failure.
   */
  async onboard(userId: string): Promise<AuthHttpIdentity | null> {
    return withRequestContext(this.database, { userId, workspaceId: '', actorType: 'user' }, async (database) => {
      await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'workspace-onboarding:' + userId}, 0))`)
      const history = await memberships(database)
      if (history.length !== 0) return credentialsIdentity(userId, history)

      const workspaceId = randomUUID()
      await database.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`)
      // SELECT visibility starts with membership, so INSERT RETURNING would fail before the owner row exists.
      await database.insert(workspaces).values({ id: workspaceId, ownerUserId: userId, name: 'Personal workspace', status: 'active' })
      await database.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' })
      return { userId, workspaceId, roles: ['owner'] }
    })
  }
}
