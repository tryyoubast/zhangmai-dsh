import {
  and,
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
  RefreshTokenStore,
} from './index.ts'

type AuthStatus = AuthUserRecord['status']

type DatabaseClientType = 'web' | 'official_client'

/** Map the public authentication client name to the constrained SQL value. */
export function toDatabaseClientType(clientType: 'browser' | 'official-client'): DatabaseClientType {
  return clientType === 'browser' ? 'web' : 'official_client'
}

/** Map the constrained SQL value back to the public authentication client name. */
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

function refreshRecord(record: typeof refreshTokens.$inferSelect): RefreshTokenRecord {
  return {
    id: record.id,
    userId: record.userId,
    sessionId: record.sessionId,
    familyId: record.familyId,
    tokenHash: record.tokenHash,
    expiresAt: record.expiresAt,
    usedAt: record.usedAt,
    revokedAt: record.revokedAt,
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

  async consumeEmailVerificationToken(tokenHash: string, now: Date): Promise<string | null> {
    const [token] = await this.database.db.update(emailVerificationTokens).set({ consumedAt: now }).where(and(
      eq(emailVerificationTokens.tokenHash, tokenHash),
      isNull(emailVerificationTokens.consumedAt),
      gt(emailVerificationTokens.expiresAt, now),
    )).returning({ userId: emailVerificationTokens.userId })
    return token?.userId ?? null
  }

  async activateUser(userId: string, now: Date): Promise<void> {
    await this.database.db.update(users).set({ status: 'active', emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, userId))
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
    await this.database.db.transaction(async (transaction) => {
      const db = transaction as unknown as DshDatabase
      await db.update(users).set({ passwordHash, passwordChangedAt: now, updatedAt: now }).where(eq(users.id, userId))
      await db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    })
  }

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

  async revokeSession(sessionId: string): Promise<void> {
    await this.database.db.update(sessions).set({ revokedAt: this.now() }).where(and(
      eq(sessions.id, sessionId),
      isNull(sessions.revokedAt),
    ))
  }

  async create(record: RefreshTokenRecord): Promise<void> {
    await this.database.db.insert(refreshTokens).values(record)
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const [record] = await this.database.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1)
    return record === undefined ? null : refreshRecord(record)
  }

  async rotate(current: RefreshTokenRecord, replacement: RefreshTokenRecord): Promise<void> {
    await this.database.db.transaction(async (transaction) => {
      const db = transaction as unknown as DshDatabase
      const [claimed] = await db.update(refreshTokens).set({ usedAt: this.now(), replacedBy: replacement.id }).where(and(
        eq(refreshTokens.id, current.id),
        isNull(refreshTokens.usedAt),
        isNull(refreshTokens.revokedAt),
      )).returning({ id: refreshTokens.id })
      if (claimed === undefined) throw new Error('refresh token was already rotated')
      await db.insert(refreshTokens).values(replacement)
    })
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.database.db.update(refreshTokens).set({ revokedAt: this.now() }).where(and(
      eq(refreshTokens.familyId, familyId),
      isNull(refreshTokens.revokedAt),
    ))
  }
}

/** Narrow alias for callers that only need refresh-token persistence. */
export class PostgresRefreshTokenStore extends PostgresAuthStore {}
