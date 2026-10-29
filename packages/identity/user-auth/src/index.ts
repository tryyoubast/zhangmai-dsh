import { createHash, randomBytes, randomUUID, sign, timingSafeEqual, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

type Argon2Function = (
  algorithm: 'argon2id',
  parameters: {
    message: Uint8Array
    nonce: Uint8Array
    parallelism: number
    memory: number
    passes: number
    tagLength: number
    secret?: Uint8Array
  },
  callback: (error: Error | undefined, digest?: Uint8Array) => void,
) => void

const argon2 = (process.getBuiltinModule?.('node:crypto') as { argon2?: Argon2Function } | undefined)?.argon2

/** Roles granted by an active workspace membership. */
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'member'

/** Authenticated identity passed from the HTTP/client layer into domain services. */
export interface AuthPrincipal {
  readonly userId: string
  readonly sessionId: string
  readonly clientType: 'browser' | 'official-client'
  readonly workspaceId: string
  readonly roles: readonly WorkspaceRole[]
  readonly actorType: 'user' | 'agent'
  readonly agentPrincipalId?: string
}

/** Domain operations checked by workspace services before opening a write transaction. */
export type WorkspaceAction = 'content:read' | 'draft:create' | 'content:write' | 'proposal:publish' | 'workspace:manage'

/** Evaluate a capability using only the authenticated principal's server-resolved roles. */
export function canPerform(principal: AuthPrincipal, action: WorkspaceAction): boolean {
  const roles = new Set(principal.roles)
  if (action === 'content:read') return roles.size > 0
  if (action === 'draft:create' || action === 'content:write') {
    return roles.has('owner') || roles.has('admin') || roles.has('editor')
  }
  if (action === 'proposal:publish') return principal.actorType === 'user' && (roles.has('owner') || roles.has('admin'))
  return roles.has('owner') || roles.has('admin')
}

/** Initial Argon2id parameters. Benchmark these values on the deployment class before production. */
export const ARGON2ID_PARAMETERS = {
  memoryKiB: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
  saltBytes: 16,
  hashBytes: 32,
} as const

/** Raised when the selected Node runtime cannot provide the required Argon2id primitive. */
export class PasswordHashingUnavailableError extends Error {
  readonly code = 'PASSWORD_HASHING_UNAVAILABLE'

  constructor() {
    super('Argon2id is required for password hashing; use a supported Node runtime')
    this.name = 'PasswordHashingUnavailableError'
  }
}

/** Raised when a stored password encoding is malformed or uses unsupported parameters. */
export class InvalidPasswordHashError extends Error {
  readonly code = 'PASSWORD_HASH_INVALID'

  constructor() {
    super('Stored password hash is invalid')
    this.name = 'InvalidPasswordHashError'
  }
}

/** Stable password hashing options; the pepper is supplied by a secret manager, never by a request. */
export interface PasswordHashOptions {
  readonly pepper?: Uint8Array
}

function requireArgon2(): Argon2Function {
  if (argon2 === undefined) throw new PasswordHashingUnavailableError()
  return argon2
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function decode(value: string): Buffer {
  try {
    return Buffer.from(value, 'base64url')
  } catch {
    throw new InvalidPasswordHashError()
  }
}

function derive(password: string, salt: Uint8Array, options: PasswordHashOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    requireArgon2()('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      parallelism: ARGON2ID_PARAMETERS.parallelism,
      memory: ARGON2ID_PARAMETERS.memoryKiB,
      passes: ARGON2ID_PARAMETERS.timeCost,
      tagLength: ARGON2ID_PARAMETERS.hashBytes,
      ...(options.pepper === undefined ? {} : { secret: options.pepper }),
    }, (error, digest) => {
      if (error != null || digest === undefined) {
        reject(error ?? new Error('Argon2id failed'))
      } else {
        resolve(Buffer.from(digest))
      }
    })
  })
}

/** Hash a password as an Argon2id PHC string. */
export async function hashPassword(password: string, options: PasswordHashOptions = {}): Promise<string> {
  validatePassword(password)
  const salt = randomBytes(ARGON2ID_PARAMETERS.saltBytes)
  const digest = await derive(password, salt, options)
  return `$argon2id$v=19$m=${String(ARGON2ID_PARAMETERS.memoryKiB)},t=${String(ARGON2ID_PARAMETERS.timeCost)},p=${String(ARGON2ID_PARAMETERS.parallelism)}$${encode(salt)}$${encode(digest)}`
}

/** Verify a password without revealing whether an account exists. */
export async function verifyPassword(password: string, encoded: string, options: PasswordHashOptions = {}): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/u.exec(encoded)
  if (match === null) throw new InvalidPasswordHashError()
  const [, memory, time, parallelism, saltText, digestText] = match
  if (memory === undefined || time === undefined || parallelism === undefined
    || saltText === undefined || digestText === undefined) throw new InvalidPasswordHashError()
  if (Number(memory) !== ARGON2ID_PARAMETERS.memoryKiB
    || Number(time) !== ARGON2ID_PARAMETERS.timeCost
    || Number(parallelism) !== ARGON2ID_PARAMETERS.parallelism) {
    throw new InvalidPasswordHashError()
  }
  const salt = decode(saltText)
  const expected = decode(digestText)
  if (salt.length !== ARGON2ID_PARAMETERS.saltBytes || expected.length !== ARGON2ID_PARAMETERS.hashBytes) {
    throw new InvalidPasswordHashError()
  }
  const actual = await derive(password, salt, options)
  return timingSafeEqual(actual, expected)
}

/** Normalize an email for uniqueness and login without altering the original display value. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().normalize('NFKC').toLocaleLowerCase('en-US')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) throw new Error('Invalid email address')
  return normalized
}

/** Validate the minimum password policy without requiring arbitrary character classes. */
export function validatePassword(password: string): void {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters')
  const weak = new Set(['passwordpassword', '123456789012', 'qwertyuiopas'])
  if (weak.has(password.toLocaleLowerCase('en-US'))) throw new Error('Password is too common')
}

/** Hash opaque session or refresh material before persistence. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Create high-entropy opaque token material for cookies and refresh tokens. */
export function createOpaqueToken(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 128) throw new Error('Token size must be between 32 and 128 bytes')
  return randomBytes(bytes).toString('base64url')
}

/** Minimal persisted user data required by registration and login. */
export interface AuthUserRecord {
  readonly id: string
  readonly email: string
  readonly emailNormalized: string
  readonly passwordHash: string
  readonly status: 'pending' | 'active' | 'suspended' | 'disabled' | 'deleted'
  readonly emailVerifiedAt: Date | null
  readonly failedLoginCount: number
  readonly lockedUntil: Date | null
  readonly passwordChangedAt?: Date
}

/** Persistence seam for authentication; implementations must perform state changes atomically. */
export interface AuthStore {
  findUserByEmail(emailNormalized: string): Promise<AuthUserRecord | null>
  insertPendingUser(user: Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>): Promise<void>
  createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>
  registerPendingUser?(user: Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>, tokenHash: string, expiresAt: Date): Promise<void>
  recordFailedLogin(userId: string, now: Date, threshold: number, lockDurationMs: number): Promise<void>
  recordSuccessfulLogin(userId: string, now: Date): Promise<void>
  createSession(input: {
    userId: string
    tokenHash: string
    clientType: 'browser' | 'official-client'
    expiresAt: Date
    userAgent?: string
    ipHash?: string
  }): Promise<{ id: string }>
}

/** Additional persistence operations required for verification and reset flows. */
export interface AuthLifecycleStore extends AuthStore {
  consumeAndActivateEmailVerification(tokenHash: string, now: Date): Promise<boolean>
  createPasswordResetToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>
  consumePasswordResetToken(tokenHash: string, now: Date): Promise<string | null>
  updatePassword(userId: string, passwordHash: string, now: Date): Promise<void>
  revokeUserSessions(userId: string): Promise<void>
  resetPassword?(userId: string, passwordHash: string, now: Date): Promise<void>
}

/** Result returned to a mail adapter; the raw verification token must never be persisted or logged. */
export interface RegistrationResult {
  readonly userId: string
  readonly verificationToken: string
}

/** Credentials returned after a successful login. Raw session material is returned once to the caller. */
export interface LoginResult {
  readonly userId: string
  readonly sessionId: string
  readonly sessionToken: string
  readonly clientType: 'browser' | 'official-client'
}

/** Service-level registration and login operations with enumeration-safe failures. */
export class UserAuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly options: {
      readonly now?: () => Date
      readonly verificationTtlMs?: number
      readonly resetTtlMs?: number
      readonly sessionTtlMs?: number
      readonly failedLoginThreshold?: number
      readonly lockDurationMs?: number
      readonly pepper?: Uint8Array
    } = {},
  ) {}

  /** Create a pending account and a one-time token for the mail adapter. */
  async register(email: string, password: string): Promise<RegistrationResult> {
    const emailNormalized = normalizeEmail(email)
    const passwordHash = await hashPassword(password, this.options.pepper === undefined ? {} : { pepper: this.options.pepper })
    const userId = cryptoRandomUuid()
    const token = createOpaqueToken()
    const pendingUser = {
      id: userId,
      email,
      emailNormalized,
      passwordHash,
      status: 'pending',
    } satisfies Omit<AuthUserRecord, 'failedLoginCount' | 'lockedUntil' | 'emailVerifiedAt'>
    const tokenHash = hashToken(token)
    const expiresAt = new Date(this.now().getTime() + (this.options.verificationTtlMs ?? 24 * 60 * 60 * 1000))
    if (this.store.registerPendingUser !== undefined) await this.store.registerPendingUser(pendingUser, tokenHash, expiresAt)
    else {
      await this.store.insertPendingUser(pendingUser)
      await this.store.createEmailVerificationToken(userId, tokenHash, expiresAt)
    }
    return { userId, verificationToken: token }
  }

  /** Authenticate a verified account; unknown, locked, and invalid credentials share the same null result. */
  async login(email: string, password: string, clientType: 'browser' | 'official-client'): Promise<LoginResult | null> {
    const user = await this.store.findUserByEmail(normalizeEmail(email))
    const now = this.now()
    if (user === null || user.status !== 'active' || user.emailVerifiedAt === null
      || (user.lockedUntil !== null && user.lockedUntil > now)) return null
    const valid = await verifyPassword(
      password,
      user.passwordHash,
      this.options.pepper === undefined ? {} : { pepper: this.options.pepper },
    )
    if (!valid) {
      await this.store.recordFailedLogin(
        user.id,
        now,
        this.options.failedLoginThreshold ?? 5,
        this.options.lockDurationMs ?? 15 * 60 * 1000,
      )
      return null
    }
    await this.store.recordSuccessfulLogin(user.id, now)
    const sessionToken = createOpaqueToken()
    const session = await this.store.createSession({
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      clientType,
      expiresAt: new Date(now.getTime() + (this.options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000)),
    })
    return { userId: user.id, sessionId: session.id, sessionToken, clientType }
  }

  /** Consume an email token once and activate the associated pending account. */
  async verifyEmail(token: string): Promise<boolean> {
    const store = this.lifecycleStore()
    return store.consumeAndActivateEmailVerification(hashToken(token), this.now())
  }

  /** Issue a one-time password reset token without revealing unknown accounts. */
  async issuePasswordReset(email: string): Promise<string | null> {
    const store = this.lifecycleStore()
    const user = await store.findUserByEmail(normalizeEmail(email))
    if (user === null || user.status === 'deleted' || user.status === 'disabled') return null
    const token = createOpaqueToken()
    await store.createPasswordResetToken(
      user.id,
      hashToken(token),
      new Date(this.now().getTime() + (this.options.resetTtlMs ?? 60 * 60 * 1000)),
    )
    return token
  }

  /** Replace a password exactly once and revoke every existing session. */
  async resetPassword(token: string, password: string): Promise<boolean> {
    validatePassword(password)
    const store = this.lifecycleStore()
    const now = this.now()
    const userId = await store.consumePasswordResetToken(hashToken(token), now)
    if (userId === null) return false
    const passwordHash = await hashPassword(password, this.options.pepper === undefined ? {} : { pepper: this.options.pepper })
    if (store.resetPassword !== undefined) await store.resetPassword(userId, passwordHash, now)
    else {
      await store.updatePassword(userId, passwordHash, now)
      await store.revokeUserSessions(userId)
    }
    return true
  }

  private lifecycleStore(): AuthLifecycleStore {
    const store = this.store as AuthLifecycleStore
    for (const method of [
      'consumeAndActivateEmailVerification', 'createPasswordResetToken',
      'consumePasswordResetToken', 'updatePassword', 'revokeUserSessions',
    ] as const) {
      if (typeof store[method] !== 'function') throw new Error(`authentication store does not implement ${method}`)
    }
    return store
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }
}

/** Small adapter surface for Redis-backed rate limits and short-lived state. */
export interface AuthRateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<boolean>
  block(key: string, durationMs: number): Promise<void>
}

/** Mail adapter contract. Implementations must never log raw token values. */
export interface AuthMailProvider {
  sendEmailVerification(input: { readonly email: string; readonly token: string; readonly expiresAt: Date }): Promise<void>
  sendPasswordReset(input: { readonly email: string; readonly token: string; readonly expiresAt: Date }): Promise<void>
}

/** Minimal request accepted by the framework-neutral authentication adapter. */
export interface AuthHttpRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | undefined>>
  /** Sanitized peer address supplied by the HTTP adapter; never trust a raw forwarded header here. */
  readonly remoteAddress?: string
  readonly body?: unknown
}

/** JSON response returned by the authentication adapter before framework mapping. */
export interface AuthHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Server-resolved workspace identity used to mint client credentials. */
export interface AuthHttpIdentity {
  readonly userId: string
  readonly workspaceId: string
  readonly roles: readonly WorkspaceRole[]
}

/** Session lookup used by `/me`, logout, and browser session invalidation. */
export interface AuthHttpSession {
  readonly userId: string
  readonly sessionId: string
  readonly clientType: 'browser' | 'official-client'
  readonly expiresAt: Date
  readonly revokedAt: Date | null
}

/** Optional persistence hooks needed after the core login service returns a raw token. */
export interface AuthHttpSessionResolver {
  findSessionByTokenHash(tokenHash: string): Promise<AuthHttpSession | null>
  /** Resolve an official-client session by the JWT sid claim. */
  findSessionById?(sessionId: string): Promise<AuthHttpSession | null>
  revokeSession(sessionId: string): Promise<void>
}

/** Request headers and server-owned dependencies used by auth middleware. */
export interface AuthPrincipalResolutionRequest {
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly now?: () => Date
  readonly sessionResolver: Partial<Pick<AuthHttpSessionResolver, 'findSessionByTokenHash' | 'findSessionById'>>
  readonly resolveIdentity: (userId: string, sessionId: string) => Promise<AuthHttpIdentity | null>
  readonly accessToken?: {
    readonly publicKey: KeyObject | string
    readonly issuer: string
    readonly audience: string
  }
}

/**
 * Resolve a browser Session or official-client access token into one server-owned
 * principal. Invalid, expired, revoked, or mis-scoped credentials return null.
 */
export async function resolveAuthPrincipal(request: AuthPrincipalResolutionRequest): Promise<AuthPrincipal | null> {
  const now = request.now?.() ?? new Date()
  const authorization = bearerValue(request.headers.authorization)
  try {
    if (authorization !== null) {
      if (request.accessToken === undefined) return null
      const claims = verifyAccessToken(authorization, {
        publicKey: request.accessToken.publicKey,
        issuer: request.accessToken.issuer,
        audience: request.accessToken.audience,
        now: now.getTime(),
      })
      const session = request.sessionResolver.findSessionById === undefined
        ? null
        : await request.sessionResolver.findSessionById(claims.sid)
      if (session === null || session === undefined || session.userId !== claims.sub
        || session.sessionId !== claims.sid || session.clientType !== 'official-client'
        || session.revokedAt !== null || session.expiresAt <= now) return null
      return principalFromIdentity(await request.resolveIdentity(claims.sub, claims.sid), 'official-client', claims.sid)
    }
    const cookie = cookieValue(request.headers.cookie, '__Host-dsh_session')
    if (cookie === null || request.sessionResolver.findSessionByTokenHash === undefined) return null
    const session = await request.sessionResolver.findSessionByTokenHash(hashToken(cookie))
    if (session === null || session.clientType !== 'browser' || session.revokedAt !== null || session.expiresAt <= now) return null
    return principalFromIdentity(await request.resolveIdentity(session.userId, session.sessionId), 'browser', session.sessionId)
  } catch {
    return null
  }
}

function principalFromIdentity(identity: AuthHttpIdentity | null, clientType: AuthPrincipal['clientType'], sessionId: string): AuthPrincipal | null {
  if (identity === null || identity.userId.trim() === '' || identity.workspaceId.trim() === '' || identity.roles.length === 0) return null
  return {
    userId: identity.userId,
    sessionId,
    clientType,
    workspaceId: identity.workspaceId,
    roles: identity.roles,
    actorType: 'user',
  }
}

/** Configuration for the framework-neutral authentication HTTP adapter. */
export interface AuthHttpControllerOptions {
  readonly allowedOrigin?: string
  readonly now?: () => Date
  readonly mail?: AuthMailProvider
  readonly security?: AuthSecurityControls
  readonly sessionResolver?: AuthHttpSessionResolver
  readonly resolveIdentity?: (userId: string, sessionId: string) => Promise<AuthHttpIdentity | null>
  readonly accessToken?: {
    readonly privateKey: KeyObject | string
    /** Public verification key used to authenticate Bearer tokens on logout. */
    readonly publicKey: KeyObject | string
    readonly issuer: string
    readonly audience: string
    readonly scope?: readonly string[]
    readonly ttlSeconds?: number
  }
}

function jsonResponse(status: number, value: Record<string, unknown>, headers: Record<string, string> = {}): AuthHttpResponse {
  return {
    status,
    headers: status === 204 ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: status === 204 ? '' : JSON.stringify(value),
  }
}

function requestBody(request: AuthHttpRequest): Record<string, unknown> {
  if (request.body === undefined || request.body === null) return {}
  if (typeof request.body === 'string') {
    try {
      const parsed = JSON.parse(request.body) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  return typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {}
}

function stringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field]
  return typeof value === 'string' ? value : null
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name && value.length > 0) return value.join('=')
  }
  return null
}

function bearerValue(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/u.exec(header ?? '')
  return match?.[1] ?? null
}

/** Serialize the only cookie accepted by the browser authentication flow. */
export function serializeHostSessionCookie(token: string, maxAgeSeconds?: number): string {
  const age = maxAgeSeconds === undefined ? '' : `; Max-Age=${String(maxAgeSeconds)}`
  return `__Host-dsh_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${age}`
}

/** Framework-neutral authentication routes used by the Web adapter. */
export class AuthHttpController {
  private readonly refreshTokens: RefreshTokenService

  constructor(
    private readonly auth: UserAuthService,
    refreshTokens: RefreshTokenService | RefreshTokenStore,
    private readonly options: AuthHttpControllerOptions = {},
  ) {
    this.refreshTokens = refreshTokens instanceof RefreshTokenService
      ? refreshTokens
      : new RefreshTokenService(refreshTokens, this.options.now)
  }

  /** Dispatch one authentication request and return a safe JSON response. */
  async handle(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    if (this.isStateChanging(request) && this.options.allowedOrigin !== undefined
      && request.headers.origin !== this.options.allowedOrigin) {
      return jsonResponse(403, { error: 'origin_check_failed' })
    }
    try {
      switch (`${request.method.toUpperCase()} ${request.path}`) {
        case 'POST /api/auth/register': return this.register(request)
        case 'POST /api/auth/verify-email': return this.verifyEmail(request)
        case 'POST /api/auth/login': return this.login(request)
        case 'POST /api/auth/logout': return this.logout(request)
        case 'POST /api/auth/refresh': return this.refresh(request)
        case 'POST /api/auth/forgot-password': return this.forgotPassword(request)
        case 'POST /api/auth/reset-password': return this.resetPassword(request)
        case 'GET /api/auth/me': return this.me(request)
        default: return jsonResponse(404, { error: 'not_found' })
      }
    } catch (error) {
      if (error instanceof Error && /password|email address|origin/u.test(error.message)) {
        return jsonResponse(400, { error: 'invalid_request' })
      }
      return jsonResponse(500, { error: 'authentication_unavailable' })
    }
  }

  private async register(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const body = requestBody(request)
    const email = stringField(body, 'email')
    const password = stringField(body, 'password')
    if (email === null || password === null) return jsonResponse(400, { error: 'invalid_request' })
    if (this.options.security !== undefined && !await this.options.security.consumeRequestBudget('register', this.rateLimitKey(request, email))) {
      return jsonResponse(429, { error: 'rate_limited' })
    }
    const result = await this.auth.register(email, password)
    if (this.options.security !== undefined) await this.options.security.sendVerification(email, result.verificationToken)
    else if (this.options.mail !== undefined) await this.options.mail.sendEmailVerification({
      email, token: result.verificationToken, expiresAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000),
    })
    return jsonResponse(202, { accepted: true })
  }

  private async verifyEmail(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const token = stringField(requestBody(request), 'token')
    if (token === null || !(await this.auth.verifyEmail(token))) return jsonResponse(400, { error: 'invalid_token' })
    return jsonResponse(204, {})
  }

  private async login(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const body = requestBody(request)
    const email = stringField(body, 'email')
    const password = stringField(body, 'password')
    const clientType = body.clientType === 'official-client' ? 'official-client' : 'browser'
    if (email === null || password === null) return jsonResponse(400, { error: 'invalid_request' })
    if (this.options.security !== undefined && !await this.options.security.consumeLoginAttempt(this.rateLimitKey(request, email))) {
      return jsonResponse(429, { error: 'rate_limited' })
    }
    const result = await this.auth.login(email, password, clientType)
    if (result === null) return jsonResponse(401, { error: 'invalid_credentials' })
    if (clientType === 'browser') {
      return jsonResponse(200, { authenticated: true }, { 'set-cookie': serializeHostSessionCookie(result.sessionToken) })
    }
    const identity = await this.resolveIdentity(result.userId, result.sessionId)
    const access = this.issueAccessToken(identity, result.sessionId)
    const refresh = await this.refreshTokens.issue(result.userId, result.sessionId)
    return jsonResponse(200, { accessToken: access, refreshToken: refresh.token, tokenType: 'Bearer' })
  }

  private async logout(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const session = await this.sessionFromRequest(request)
    if (session !== null && this.options.sessionResolver !== undefined) {
      await this.options.sessionResolver.revokeSession(session.sessionId)
    }
    return jsonResponse(204, {}, { 'set-cookie': serializeHostSessionCookie('', 0) })
  }

  private async sessionFromRequest(request: AuthHttpRequest): Promise<AuthHttpSession | null> {
    const resolver = this.options.sessionResolver
    if (resolver === undefined) return null

    const authorization = bearerValue(request.headers.authorization)
    if (authorization !== null) {
      const accessToken = this.options.accessToken
      if (accessToken === undefined || resolver.findSessionById === undefined) return null
      try {
        const claims = verifyAccessToken(authorization, {
          publicKey: accessToken.publicKey,
          issuer: accessToken.issuer,
          audience: accessToken.audience,
          now: this.now().getTime(),
        })
        const session = await resolver.findSessionById(claims.sid)
        if (session === null || session.userId !== claims.sub || session.sessionId !== claims.sid
          || session.clientType !== 'official-client' || session.revokedAt !== null || session.expiresAt <= this.now()) {
          return null
        }
        return session
      } catch {
        return null
      }
    }

    const cookie = cookieValue(request.headers.cookie, '__Host-dsh_session')
    if (cookie === null || resolver.findSessionByTokenHash === undefined) return null
    const session = await resolver.findSessionByTokenHash(hashToken(cookie))
    if (session === null || session.clientType !== 'browser' || session.revokedAt !== null || session.expiresAt <= this.now()) {
      return null
    }
    return session
  }

  private async refresh(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const token = stringField(requestBody(request), 'refreshToken') ?? bearerValue(request.headers.authorization)
    if (token === null) return jsonResponse(401, { error: 'invalid_refresh_token' })
    const findSessionById = this.options.sessionResolver?.findSessionById
    if (findSessionById === undefined) return jsonResponse(401, { error: 'invalid_refresh_token' })
    const rotated = await this.refreshTokens.rotate(token)
    if (rotated === null) return jsonResponse(401, { error: 'invalid_refresh_token' })
    const session = await findSessionById(rotated.sessionId)
    if (session === null || session.userId !== rotated.userId || session.clientType !== 'official-client'
      || session.revokedAt !== null || session.expiresAt <= this.now()) {
      await this.refreshTokens.revokeFamily(rotated.familyId)
      return jsonResponse(401, { error: 'invalid_refresh_token' })
    }
    const identity = await this.resolveIdentity(rotated.userId, rotated.sessionId)
    const access = this.issueAccessToken(identity, rotated.sessionId)
    return jsonResponse(200, { accessToken: access, refreshToken: rotated.token, tokenType: 'Bearer' })
  }

  private async forgotPassword(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const email = stringField(requestBody(request), 'email')
    if (email !== null && (this.options.security === undefined
      || await this.options.security.consumeRequestBudget('password-reset', this.rateLimitKey(request, email)))) {
      const token = await this.auth.issuePasswordReset(email)
      if (token !== null && this.options.security !== undefined) await this.options.security.sendPasswordReset(email, token)
      else if (token !== null && this.options.mail !== undefined) await this.options.mail.sendPasswordReset({
        email, token, expiresAt: new Date(this.now().getTime() + 60 * 60 * 1000),
      })
    }
    return jsonResponse(202, { accepted: true })
  }

  private async resetPassword(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const body = requestBody(request)
    const token = stringField(body, 'token')
    const password = stringField(body, 'password')
    if (token === null || password === null || !(await this.auth.resetPassword(token, password))) {
      return jsonResponse(400, { error: 'invalid_token' })
    }
    return jsonResponse(204, {})
  }

  private async me(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const session = await this.sessionFromRequest(request)
    if (session === null) return jsonResponse(401, { error: 'unauthorized' })
    const identity = await this.resolveIdentity(session.userId, session.sessionId)
    return identity === null ? jsonResponse(401, { error: 'unauthorized' }) : jsonResponse(200, {
      userId: identity.userId,
      sessionId: session.sessionId,
      clientType: session.clientType,
      workspaceId: identity.workspaceId,
      roles: identity.roles,
    })
  }

  private async resolveIdentity(userId: string, sessionId: string): Promise<AuthHttpIdentity> {
    const identity = await this.options.resolveIdentity?.(userId, sessionId)
    if (identity === null || identity === undefined) throw new Error('authenticated workspace identity is unavailable')
    return identity
  }

  private issueAccessToken(identity: AuthHttpIdentity, sessionId: string): string {
    const options = this.options.accessToken
    if (options === undefined) throw new Error('official-client access tokens are not configured')
    return createAccessToken({
      userId: identity.userId,
      sessionId,
      scope: options.scope ?? ['workspace:read', 'novel:draft'],
    }, options)
  }

  private isStateChanging(request: AuthHttpRequest): boolean {
    return !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private rateLimitKey(request: AuthHttpRequest, email: string): string {
    return `${request.remoteAddress ?? 'unknown'}:${hashToken(normalizeEmail(email))}`
  }
}

/** Auth control helpers that keep Redis and mail concerns outside core identity logic. */
export class AuthSecurityControls {
  constructor(
    private readonly rateLimiter: AuthRateLimiter,
    private readonly mail: AuthMailProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Apply a bounded login attempt budget. */
  consumeLoginAttempt(key: string): Promise<boolean> {
    return this.rateLimiter.consume(`auth:login:${key}`, 10, 60_000)
  }

  /** Apply a bounded registration/reset request budget. */
  consumeRequestBudget(kind: 'register' | 'password-reset', key: string): Promise<boolean> {
    return this.rateLimiter.consume(`auth:${kind}:${key}`, 5, 60 * 60_000)
  }

  /** Temporarily block a login key after repeated failures. */
  blockLogin(key: string, durationMs = 15 * 60_000): Promise<void> {
    return this.rateLimiter.block(`auth:login:${key}`, durationMs)
  }

  /** Send a verification message without exposing the token to logs. */
  sendVerification(email: string, token: string, ttlMs = 24 * 60 * 60_000): Promise<void> {
    return this.mail.sendEmailVerification({ email, token, expiresAt: new Date(this.now().getTime() + ttlMs) })
  }

  /** Send a reset message without exposing the token to logs. */
  sendPasswordReset(email: string, token: string, ttlMs = 60 * 60_000): Promise<void> {
    return this.mail.sendPasswordReset({ email, token, expiresAt: new Date(this.now().getTime() + ttlMs) })
  }
}

/** Minimal Redis command surface used by the authentication rate limiter. */
export interface RedisCommandClient {
  send(command: string, ...args: string[]): Promise<unknown>
}

/** Redis-backed fixed-window limiter with atomic increment and expiry. */
export class RedisAuthRateLimiter implements AuthRateLimiter {
  constructor(private readonly redis: RedisCommandClient) {}

  async consume(key: string, limit: number, windowMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new Error('rate-limit parameters must be positive integers')
    }
    const result = await this.redis.send(
      'EVAL',
      'local count=redis.call("INCR",KEYS[1]); if count == 1 then redis.call("PEXPIRE",KEYS[1],ARGV[2]); end; return count <= tonumber(ARGV[1]) and 1 or 0',
      '1',
      key,
      String(limit),
      String(windowMs),
    )
    return Number(result) === 1
  }

  async block(key: string, durationMs: number): Promise<void> {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new Error('block duration must be a positive integer')
    await this.redis.send('SET', key, '1', 'PX', String(durationMs))
  }
}

/** Generic sender used by email integrations; tokens are passed only to the sender. */
export interface TransactionalMailSender {
  send(input: {
    readonly template: 'email-verification' | 'password-reset'
    readonly to: string
    readonly token: string
    readonly expiresAt: Date
  }): Promise<void>
}

/** Mail provider that has no logging or persistence behavior of its own. */
export class AuthTemplateMailProvider implements AuthMailProvider {
  constructor(private readonly sender: TransactionalMailSender) {}

  sendEmailVerification(input: { readonly email: string; readonly token: string; readonly expiresAt: Date }): Promise<void> {
    return this.sender.send({ template: 'email-verification', to: input.email, token: input.token, expiresAt: input.expiresAt })
  }

  sendPasswordReset(input: { readonly email: string; readonly token: string; readonly expiresAt: Date }): Promise<void> {
    return this.sender.send({ template: 'password-reset', to: input.email, token: input.token, expiresAt: input.expiresAt })
  }
}

/** Persisted refresh-token metadata; raw token material is never part of this record. */
export interface RefreshTokenRecord {
  readonly id: string
  readonly userId: string
  readonly sessionId: string
  readonly familyId: string
  readonly tokenHash: string
  readonly expiresAt: Date
  readonly usedAt: Date | null
  readonly revokedAt: Date | null
}

/** Atomic persistence seam for refresh-token rotation and family revocation. */
export interface RefreshTokenStore {
  create(record: RefreshTokenRecord): Promise<void>
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>
  rotate(current: RefreshTokenRecord, replacement: RefreshTokenRecord): Promise<void>
  revokeFamily(familyId: string): Promise<void>
}

/** Opaque refresh-token lifecycle with reuse detection. */
export class RefreshTokenService {
  constructor(
    private readonly store: RefreshTokenStore,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 30 * 24 * 60 * 60_000,
  ) {}

  /** Issue the first token in a new family. */
  async issue(userId: string, sessionId: string): Promise<{ token: string; familyId: string; id: string }> {
    const token = createOpaqueToken(48)
    const id = randomUUID()
    const familyId = randomUUID()
    await this.store.create({
      id,
      userId,
      sessionId,
      familyId,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.now().getTime() + this.ttlMs),
      usedAt: null,
      revokedAt: null,
    })
    return { token, familyId, id }
  }

  /** Rotate a valid token; a reused token revokes its entire family. */
  async rotate(token: string): Promise<{ token: string; familyId: string; id: string; userId: string; sessionId: string } | null> {
    const current = await this.store.findByHash(hashToken(token))
    const now = this.now()
    if (current === null || current.revokedAt !== null || current.expiresAt <= now) return null
    if (current.usedAt !== null) {
      await this.store.revokeFamily(current.familyId)
      return null
    }
    const replacementToken = createOpaqueToken(48)
    const replacement = {
      id: randomUUID(),
      userId: current.userId,
      sessionId: current.sessionId,
      familyId: current.familyId,
      tokenHash: hashToken(replacementToken),
      expiresAt: new Date(now.getTime() + this.ttlMs),
      usedAt: null,
      revokedAt: null,
    } satisfies RefreshTokenRecord
    await this.store.rotate(current, replacement)
    return {
      token: replacementToken,
      familyId: replacement.familyId,
      id: replacement.id,
      userId: replacement.userId,
      sessionId: replacement.sessionId,
    }
  }

  /** Revoke a token family when its owning Session is no longer valid. */
  revokeFamily(familyId: string): Promise<void> {
    return this.store.revokeFamily(familyId)
  }
}

/** Claims carried by a short-lived official-client access token. */
export interface AccessTokenClaims {
  readonly iss: string
  readonly aud: string
  readonly sub: string
  readonly sid: string
  readonly jti: string
  readonly iat: number
  readonly exp: number
  readonly scope: readonly string[]
}

export class AccessTokenInvalidError extends Error {
  readonly code = 'ACCESS_TOKEN_INVALID'

  constructor() {
    super('Access token is invalid or expired')
    this.name = 'AccessTokenInvalidError'
  }
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new AccessTokenInvalidError()
  }
}

/** Create an EdDSA JWT without placing email, password, or other PII in claims. */
export function createAccessToken(
  input: { readonly userId: string; readonly sessionId: string; readonly scope: readonly string[] },
  options: {
    readonly privateKey: KeyObject | string
    readonly issuer: string
    readonly audience: string
    readonly now?: number
    readonly ttlSeconds?: number
  },
): string {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  const ttlSeconds = options.ttlSeconds ?? 10 * 60
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 900) {
    throw new Error('Access token TTL must be between 300 and 900 seconds')
  }
  const header = base64Url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const claims: AccessTokenClaims = {
    iss: options.issuer,
    aud: options.audience,
    sub: input.userId,
    sid: input.sessionId,
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    scope: [...input.scope],
  }
  const payload = base64Url(JSON.stringify(claims))
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), options.privateKey)
  return `${signingInput}.${base64Url(signature)}`
}

/** Verify an EdDSA access token and its issuer, audience, and lifetime. */
export function verifyAccessToken(
  token: string,
  options: {
    readonly publicKey: KeyObject | string
    readonly issuer: string
    readonly audience: string
    readonly now?: number
  },
): AccessTokenClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessTokenInvalidError()
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
    throw new AccessTokenInvalidError()
  }
  const header = parseJson<{ alg?: string; typ?: string }>(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new AccessTokenInvalidError()
  const validSignature = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
    options.publicKey,
    Buffer.from(encodedSignature, 'base64url'),
  )
  if (!validSignature) throw new AccessTokenInvalidError()
  const claims = parseJson<Partial<AccessTokenClaims>>(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  if (claims.iss !== options.issuer || claims.aud !== options.audience
    || typeof claims.sub !== 'string' || typeof claims.sid !== 'string'
    || typeof claims.jti !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number'
    || !Array.isArray(claims.scope) || claims.scope.some(scope => typeof scope !== 'string')
    || claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp - claims.iat > 900) {
    throw new AccessTokenInvalidError()
  }
  return claims as AccessTokenClaims
}

function cryptoRandomUuid(): string {
  return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-4$3-8$4-$5')
}

export { PostgresAuthStore, PostgresRefreshTokenStore } from './postgres.ts'
