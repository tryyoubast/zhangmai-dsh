/** Persist hashed authentication material; combined lifecycle operations own their database transactions. */
import {
  and,
  asc,
  auditEvents,
  emailVerificationTokens,
  eq,
  gt,
  isNull,
  passwordResetTokens,
  refreshTokens,
  sessions,
  sql,
  users,
  type DatabaseClient,
  type DshDatabase,
} from '@deepseek-ai/dsh-database-postgres'
import type {
  AuthHttpSession,
  AuthLifecycleStore,
  AuthUserRecord,
  RefreshTokenRecord,
  RefreshTokenReplacement,
  RefreshTokenRotationResult,
  RefreshTokenStore,
} from './index.ts'

type AuthStatus = AuthUserRecord['status']

type DatabaseClientType = 'web' | 'official_client'

type AuthTransaction = Parameters<Parameters<DshDatabase['transaction']>[0]>[0]

async function lockRefreshUser(db: AuthTransaction, userId: string, mode: 'key share' | 'update'): Promise<boolean> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).for(mode)
  return user !== undefined
}

async function lockRefreshFamily(db: AuthTransaction, familyId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dsh:auth:refresh-family:${familyId}`}, 0))`)
}

/**
 * Map the public authentication client name to the constrained SQL value.
 * @param clientType - Browser or official-client category accepted by the authentication API.
 * @returns The corresponding web or official_client database value.
 */
export function toDatabaseClientType(clientType: 'browser' | 'official-client'): DatabaseClientType {
  return clientType === 'browser' ? 'web' : 'official_client'
}

/**
 * Map the constrained SQL value back to the public authentication client name.
 * @param clientType - Persisted web or official_client category.
 * @returns The corresponding browser or official-client API value.
 */
export function fromDatabaseClientType(clientType: DatabaseClientType): 'browser' | 'official-client' {
  return clientType === 'web' ? 'browser' : 'official-client'
}

function authUser(record: typeof users.$inferSelect): AuthUserRecord {
  return {
    id: record.id,
    email: record.email,
    emailNormalized: record.emailNormalized,
    passwordHash: record.passwordHash,
    status: record.status as AuthStatus,
    emailVerifiedAt: record.emailVerifiedAt,
    failedLoginCount: record.failedLoginCount,
    lockedUntil: record.lockedUntil,
    passwordChangedAt: record.passwordChangedAt,
  }
}

/** Drizzle-backed auth store. It never accepts or persists raw token material. */
export class PostgresAuthStore implements AuthLifecycleStore, RefreshTokenStore {
  constructor(private readonly database: DatabaseClient<DshDatabase>, private readonly now: () => Date = () => new Date()) {}

  async findUserByEmail(emailNormalized: string): Promise<AuthUserRecord | null> {
    const [record] = await this.database.db.select().from(users).where(eq(users.emailNormalized, emailNormalized)).limit(1)
    return record === undefined ? null : authUser(record)
  }

  async insertPendingUser(user: Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>): Promise<void> {
    await this.database.db.insert(users).values({
      id: user.id,
      email: user.email,
      emailNormalized: user.emailNormalized,
      passwordHash: user.passwordHash,
      status: user.status,
      passwordChangedAt: user.passwordChangedAt ?? this.now(),
    })
  }

  async createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.database.db.insert(emailVerificationTokens).values({ userId, tokenHash, expiresAt })
  }

  async registerPendingUser(
    user: Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.database.db.transaction(async (transaction) => {
      const db = transaction as unknown as DshDatabase
      await db.insert(users).values({
        id: user.id,
        email: user.email,
        emailNormalized: user.emailNormalized,
        passwordHash: user.passwordHash,
        status: user.status,
        passwordChangedAt: user.passwordChangedAt ?? this.now(),
      })
      await db.insert(emailVerificationTokens).values({ userId: user.id, tokenHash, expiresAt })
    })
  }

  async recordFailedLogin(userId: string, now: Date, threshold: number, lockDurationMs: number): Promise<void> {
    if (!Number.isSafeInteger(threshold) || threshold < 1 || !Number.isSafeInteger(lockDurationMs) || lockDurationMs < 1) {
      throw new Error('login lock parameters must be positive integers')
    }
    const lockedUntil = new Date(now.getTime() + lockDurationMs)
    await this.database.db.update(users).set({
      failedLoginCount: sql`${users.failedLoginCount} + 1`,
      lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${threshold} THEN ${lockedUntil} ELSE ${users.lockedUntil} END`,
      updatedAt: now,
    }).where(eq(users.id, userId))
  }

  async recordSuccessfulLogin(userId: string, now: Date): Promise<void> {
    await this.database.db.update(users).set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: now,
      updatedAt: now,
    }).where(eq(users.id, userId))
  }

  async createSession(input: {
    userId: string
    tokenHash: string
    clientType: 'browser' | 'official-client'
    expiresAt: Date
    userAgent?: string
    ipHash?: string
  }): Promise<{ id: string }> {
    const [session] = await this.database.db.insert(sessions).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      clientType: toDatabaseClientType(input.clientType),
      expiresAt: input.expiresAt,
      lastSeenAt: this.now(),
      userAgent: input.userAgent,
      ipHash: input.ipHash,
    }).returning({ id: sessions.id })
    if (session === undefined) throw new Error('session was not created')
    return session
  }

  async consumeAndActivateEmailVerification(tokenHash: string, now: Date): Promise<boolean> {
    return this.database.db.transaction(async (transaction) => {
      const db = transaction as unknown as DshDatabase
      const [token] = await db.update(emailVerificationTokens).set({ consumedAt: now }).where(and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        isNull(emailVerificationTokens.consumedAt),
        gt(emailVerificationTokens.expiresAt, now),
      )).returning({ userId: emailVerificationTokens.userId })
      if (token === undefined) return false

      const activatedUsers = await db.update(users).set({
        status: 'active',
        emailVerifiedAt: now,
        updatedAt: now,
      }).where(eq(users.id, token.userId)).returning({ id: users.id })
      if (activatedUsers.length !== 1) throw new Error('user was not activated')
      return true
    })
  }

  async createPasswordResetToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.database.db.insert(passwordResetTokens).values({ userId, tokenHash, expiresAt })
  }

  async consumePasswordResetToken(tokenHash: string, now: Date): Promise<string | null> {
    const [token] = await this.database.db.update(passwordResetTokens).set({ consumedAt: now }).where(and(
      eq(passwordResetTokens.tokenHash, tokenHash),
      isNull(passwordResetTokens.consumedAt),
      gt(passwordResetTokens.expiresAt, now),
    )).returning({ userId: passwordResetTokens.userId })
    return token?.userId ?? null
  }

  async updatePassword(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.database.db.update(users).set({ passwordHash, passwordChangedAt: now, updatedAt: now }).where(eq(users.id, userId))
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.database.db.update(sessions).set({ revokedAt: this.now() }).where(and(
      eq(sessions.userId, userId),
      isNull(sessions.revokedAt),
    ))
  }

  async resetPassword(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.database.db.transaction(async (db) => {
      if (!await lockRefreshUser(db, userId, 'update')) return
      // Exclusive user locking excludes issuance and rotation while families are enumerated.
      const families = await db.select({ familyId: refreshTokens.familyId }).from(refreshTokens)
        .where(eq(refreshTokens.userId, userId)).groupBy(refreshTokens.familyId).orderBy(asc(refreshTokens.familyId))
      for (const { familyId } of families) await lockRefreshFamily(db, familyId)
      await db.update(users).set({ passwordHash, passwordChangedAt: now, updatedAt: now }).where(eq(users.id, userId))
      await db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    }, { isolationLevel: 'read committed' })
  }

  /**
   * Look up session metadata by its stored credential hash without checking validity.
   * @param tokenHash - SHA-256 digest of the raw session token.
   * @returns Session metadata or null; callers must check client type, expiry, and revocation.
   */
  async findSessionByTokenHash(tokenHash: string): Promise<AuthHttpSession | null> {
    const [session] = await this.database.db.select({
      userId: sessions.userId,
      sessionId: sessions.id,
      clientType: sessions.clientType,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    }).from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1)
    if (session === undefined) return null
    return { ...session, clientType: fromDatabaseClientType(session.clientType as DatabaseClientType) }
  }

  /**
   * Look up session metadata for an official-client JWT without checking validity.
   * @param sessionId - Persisted session ID from the verified sid claim.
   * @returns Session metadata or null; callers must check user, client type, expiry, and revocation.
   */
  async findSessionById(sessionId: string): Promise<AuthHttpSession | null> {
    const [session] = await this.database.db.select({
      userId: sessions.userId,
      sessionId: sessions.id,
      clientType: sessions.clientType,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (session === undefined) return null
    return { ...session, clientType: fromDatabaseClientType(session.clientType as DatabaseClientType) }
  }

  /**
   * Mark an unrevoked session revoked without deleting it or its refresh-token family.
   * @param sessionId - Session to revoke; missing or already-revoked sessions are unchanged.
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.database.db.update(sessions).set({ revokedAt: this.now() }).where(and(
      eq(sessions.id, sessionId),
      isNull(sessions.revokedAt),
    ))
  }

  async create(record: RefreshTokenRecord): Promise<void> {
    await this.database.db.transaction(async (db) => {
      if (!await lockRefreshUser(db, record.userId, 'key share')) throw new Error('refresh token owner does not exist')
      await lockRefreshFamily(db, record.familyId)
      await db.insert(refreshTokens).values(record)
    }, { isolationLevel: 'read committed' })
  }

  async rotate(tokenHash: string, replacement: RefreshTokenReplacement, now: Date): Promise<RefreshTokenRotationResult> {
    return this.database.db.transaction(async (db): Promise<RefreshTokenRotationResult> => {
      const [location] = await db.select({ userId: refreshTokens.userId, familyId: refreshTokens.familyId })
        .from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1)
      if (location === undefined || !await lockRefreshUser(db, location.userId, 'key share')) return { status: 'invalid' }
      await lockRefreshFamily(db, location.familyId)
      // A separate READ COMMITTED statement observes descendants committed while the family lock was awaited.
      const [current] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).for('update')
      if (current === undefined || current.revokedAt !== null || current.expiresAt <= now) return { status: 'invalid' }
      if (current.usedAt !== null) {
        await db.update(refreshTokens).set({ revokedAt: now }).where(and(
          eq(refreshTokens.familyId, current.familyId), isNull(refreshTokens.revokedAt),
        ))
        await db.insert(auditEvents).values({
          workspaceId: null, actorType: 'system', actorId: 'auth.refresh_token_service',
          action: 'auth.refresh_token_reuse_detected', targetType: 'refresh_token_family', targetId: current.familyId,
          metadata: { userId: current.userId, sessionId: current.sessionId, tokenId: current.id }, createdAt: now,
        })
        return { status: 'reused' }
      }
      // replaced_by has an immediate self-reference in the released SQL schema.
      await db.insert(refreshTokens).values({
        ...replacement, userId: current.userId, sessionId: current.sessionId,
        familyId: current.familyId, usedAt: null, revokedAt: null,
      })
      await db.update(refreshTokens).set({ usedAt: now, replacedBy: replacement.id }).where(eq(refreshTokens.id, current.id))
      return { status: 'rotated', id: replacement.id, userId: current.userId, sessionId: current.sessionId, familyId: current.familyId }
    }, { isolationLevel: 'read committed' })
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.database.db.transaction(async (db) => {
      const [location] = await db.select({ userId: refreshTokens.userId }).from(refreshTokens)
        .where(eq(refreshTokens.familyId, familyId)).limit(1)
      if (location === undefined || !await lockRefreshUser(db, location.userId, 'key share')) return
      await lockRefreshFamily(db, familyId)
      await db.update(refreshTokens).set({ revokedAt: this.now() }).where(and(
        eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt),
      ))
    }, { isolationLevel: 'read committed' })
  }
}

/** Narrow alias for callers that only need refresh-token persistence. */
export class PostgresRefreshTokenStore extends PostgresAuthStore {}
