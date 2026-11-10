/** Authentication primitives and framework-neutral routes; persistence, mail, and rate limiting are injected. */
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

const argon2 = (process.getBuiltinModule('node:crypto') as { argon2?: Argon2Function } | undefined)?.argon2

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

/**
 * Evaluate workspace capabilities using server-resolved roles and actor type.
 * @param principal - Authenticated actor and active workspace roles.
 * @param action - Domain operation whose permission is required.
 * @returns Whether the roles permit the action; publication additionally requires a human actor.
 */
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
  /**
   * Stable identifier for runtimes without the required Argon2id implementation.
   */
  readonly code = 'PASSWORD_HASHING_UNAVAILABLE'

  constructor() {
    super('Argon2id is required for password hashing; use a supported Node runtime')
    this.name = 'PasswordHashingUnavailableError'
  }
}

/** Raised when a stored password encoding is malformed or uses unsupported parameters. */
export class InvalidPasswordHashError extends Error {
  /**
   * Stable identifier for malformed or unsupported stored password hashes.
   */
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
  return Buffer.from(value, 'base64url')
}

// The fixed PHC expression has five mandatory captures on every successful match.
function hasPasswordHashParts(match: RegExpExecArray | null): match is RegExpExecArray & [string, string, string, string, string, string] {
  return match !== null
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

/**
 * Hash a policy-compliant password as an Argon2id PHC string with a fresh salt.
 * @param password - Plaintext password satisfying validatePassword.
 * @param options - Optional deployment-owned pepper; the same pepper is required for verification.
 * @returns The encoded algorithm, parameters, salt, and derived password digest.
 * @throws For a rejected password policy, unavailable Argon2id primitive, or hashing failure.
 */
export async function hashPassword(password: string, options: PasswordHashOptions = {}): Promise<string> {
  validatePassword(password)
  const salt = randomBytes(ARGON2ID_PARAMETERS.saltBytes)
  const digest = await derive(password, salt, options)
  return `$argon2id$v=19$m=${String(ARGON2ID_PARAMETERS.memoryKiB)},t=${String(ARGON2ID_PARAMETERS.timeCost)},p=${String(ARGON2ID_PARAMETERS.parallelism)}$${encode(salt)}$${encode(digest)}`
}

/**
 * Compare a password against a stored Argon2id digest using constant-time digest comparison.
 * @param password - Plaintext password to verify.
 * @param encoded - Stored PHC string using the supported Argon2id parameters.
 * @param options - Deployment-owned pepper used when the password was hashed.
 * @returns Whether the derived digest matches the stored digest.
 * @throws For malformed or unsupported hashes, unavailable Argon2id, or derivation failure.
 */
export async function verifyPassword(password: string, encoded: string, options: PasswordHashOptions = {}): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/u.exec(encoded)
  if (!hasPasswordHashParts(match)) throw new InvalidPasswordHashError()
  const [, memory, time, parallelism, saltText, digestText] = match
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

/** Email and password input failures eligible for a sanitized HTTP 400 response. */
class AuthInputValidationError extends Error {}

/**
 * Normalize an email for uniqueness and login while leaving display storage to the caller.
 * @param email - Email value to trim, normalize with NFKC, and lowercase using en-US.
 * @returns The normalized email address.
 * @throws When the normalized value fails basic email syntax validation.
 */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().normalize('NFKC').toLocaleLowerCase('en-US')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) throw new AuthInputValidationError('Invalid email address')
  return normalized
}

/**
 * Require at least twelve characters and reject the fixed common-password list.
 * @param password - Plaintext password to check without changing it.
 * @throws When the password is too short or matches a listed common password.
 */
export function validatePassword(password: string): void {
  if (password.length < 12) throw new AuthInputValidationError('Password must contain at least 12 characters')
  const weak = new Set(['passwordpassword', '123456789012', 'qwertyuiopas'])
  if (weak.has(password.toLocaleLowerCase('en-US'))) throw new AuthInputValidationError('Password is too common')
}

/**
 * Hash opaque session or refresh material before persistence.
 * @param token - Raw token material; callers must keep it out of logs and persisted records.
 * @returns The lowercase hexadecimal SHA-256 digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Create cryptographically random token material for cookies and refresh credentials.
 * @param bytes - Random-byte count, defaulting to 32; must be an integer from 32 through 128.
 * @returns A base64url-encoded token to expose only to its intended recipient.
 * @throws When the byte count is unsupported or random generation fails.
 */
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

/**
 * Register accounts and manage password-based authentication through injected persistence.
 * Validation, hashing, and store failures reject. Optional combined store operations provide atomic registration and password updates;
 * fallback operations execute separately, and reset tokens are consumed before password hashing and writes.
 */
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

  /**
   * Create a pending account and a one-time verification token for the mail adapter.
   * @param email - Address stored for display and normalized for account uniqueness.
   * @param password - Plaintext password to validate and hash.
   * @returns The new user ID and raw verification token, which the caller must neither persist nor log.
   * @throws For invalid credentials, hashing failure, or store errors such as duplicate email registration.
   */
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

  /**
   * Authenticate a verified account and create a session, recording success or failed-password counters.
   * @param email - Address normalized before account lookup.
   * @param password - Plaintext password to compare with the stored digest.
   * @param clientType - Browser-cookie or official-client session category.
   * @returns Session credentials on success, or null for unknown, inactive, unverified, locked, or incorrect-password accounts.
   */
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

  /**
   * Consume an unexpired email token once and activate its associated account.
   * @param token - Raw verification token delivered by the mail adapter.
   * @returns True when consumed and activated, or false when no usable token exists.
   * @throws When the store lacks required lifecycle methods or the persistence operation fails.
   */
  async verifyEmail(token: string): Promise<boolean> {
    const store = this.lifecycleStore()
    return store.consumeAndActivateEmailVerification(hashToken(token), this.now())
  }

  /**
   * Issue a one-time password reset token for an eligible account.
   * @param email - Address normalized before account lookup.
   * @returns A raw token for the mail adapter, or null for an unknown, deleted, or disabled account.
   * @throws For invalid email syntax, unavailable lifecycle methods, or persistence failure.
   */
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

  /**
   * Consume a reset token, replace the password, and revoke sessions through the configured store.
   * @param token - Raw one-time reset token; consumption precedes hashing and password writes.
   * @param password - New plaintext password satisfying the password policy.
   * @returns True after the password and revocation operations finish, or false when no usable token exists.
   * @throws For invalid passwords or store and hashing failures; a consumed token is not restored on later failure.
   */
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
 * Resolve a browser session or official-client JWT into a server-owned principal.
 * @param request - Headers, trusted session and workspace resolvers, clock, and JWT verification settings.
 * @returns A human principal, or null for invalid, expired, revoked, mis-scoped, or unresolved credentials and resolver failures.
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
      if (session === null || session.userId !== claims.sub
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

/**
 * Serialize the Secure, HttpOnly, SameSite=Lax host-only browser session cookie.
 * @param token - Opaque cookie token, or an empty string when clearing the cookie.
 * @param maxAgeSeconds - Optional cookie lifetime in seconds; zero requests immediate expiration.
 * @returns The Set-Cookie header value with Path=/ and no Domain attribute.
 */
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

  /**
   * Dispatch an authentication route after the configured state-changing origin check.
   * @param request - Adapter-supplied method, path, headers, peer address, and optional JSON body.
   * @returns The route response, including 403 for origin mismatch, 404 for unknown routes,
   * and sanitized 400 or 500 responses for route failures.
   */
  async handle(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    if (this.isStateChanging(request) && this.options.allowedOrigin !== undefined
      && request.headers.origin !== this.options.allowedOrigin) {
      return jsonResponse(403, { error: 'origin_check_failed' })
    }
    try {
      switch (`${request.method.toUpperCase()} ${request.path}`) {
        case 'POST /api/auth/register': return await this.register(request)
        case 'POST /api/auth/verify-email': return await this.verifyEmail(request)
        case 'POST /api/auth/login': return await this.login(request)
        case 'POST /api/auth/logout': return await this.logout(request)
        case 'POST /api/auth/refresh': return await this.refresh(request)
        case 'POST /api/auth/forgot-password': return await this.forgotPassword(request)
        case 'POST /api/auth/reset-password': return await this.resetPassword(request)
        case 'GET /api/auth/me': return await this.me(request)
        default: return jsonResponse(404, { error: 'not_found' })
      }
    } catch (error) {
      if (error instanceof AuthInputValidationError) {
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
    if (cookie === null) return null
    const session = await resolver.findSessionByTokenHash(hashToken(cookie))
    if (session === null || session.clientType !== 'browser' || session.revokedAt !== null || session.expiresAt <= this.now()) {
      return null
    }
    return session
  }

  private async refresh(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    const token = stringField(requestBody(request), 'refreshToken') ?? bearerValue(request.headers.authorization)
    if (token === null) return jsonResponse(401, { error: 'invalid_refresh_token' })
    const resolver = this.options.sessionResolver
    if (resolver?.findSessionById === undefined) return jsonResponse(401, { error: 'invalid_refresh_token' })
    const rotated = await this.refreshTokens.rotate(token)
    if (rotated === null) return jsonResponse(401, { error: 'invalid_refresh_token' })
    const session = await resolver.findSessionById(rotated.sessionId)
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
    return jsonResponse(200, {
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

  /**
   * Consume the ten-attempt, one-minute login budget for a key.
   * @param key - Caller-derived identity for grouping login attempts.
   * @returns Whether the attempt is within budget; rate-limiter failures reject.
   */
  consumeLoginAttempt(key: string): Promise<boolean> {
    return this.rateLimiter.consume(`auth:login:${key}`, 10, 60_000)
  }

  /**
   * Consume the five-request, one-hour registration or password-reset budget.
   * @param kind - Operation whose rate-limit namespace is charged.
   * @param key - Caller-derived identity for grouping requests.
   * @returns Whether the request is within budget; rate-limiter failures reject.
   */
  consumeRequestBudget(kind: 'register' | 'password-reset', key: string): Promise<boolean> {
    return this.rateLimiter.consume(`auth:${kind}:${key}`, 5, 60 * 60_000)
  }

  /**
   * Ask the rate limiter to temporarily block a login key.
   * @param key - Caller-derived login identity, namespaced by this service.
   * @param durationMs - Block lifetime in milliseconds, defaulting to fifteen minutes.
   */
  blockLogin(key: string, durationMs = 15 * 60_000): Promise<void> {
    return this.rateLimiter.block(`auth:login:${key}`, durationMs)
  }

  /**
   * Pass a raw verification token only to the mail provider, with its delivery expiry.
   * @param email - Destination address.
   * @param token - Raw token that must not be logged by the provider.
   * @param ttlMs - Lifetime from the injected clock, defaulting to twenty-four hours.
   */
  sendVerification(email: string, token: string, ttlMs = 24 * 60 * 60_000): Promise<void> {
    return this.mail.sendEmailVerification({ email, token, expiresAt: new Date(this.now().getTime() + ttlMs) })
  }

  /**
   * Pass a raw reset token only to the mail provider, with its delivery expiry.
   * @param email - Destination address.
   * @param token - Raw token that must not be logged by the provider.
   * @param ttlMs - Lifetime from the injected clock, defaulting to one hour.
   */
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

/** Replacement material generated before the store transaction; identity comes from the persisted token. */
export interface RefreshTokenReplacement {
  readonly id: string
  readonly tokenHash: string
  readonly expiresAt: Date
}

/** Committed rotation outcome; normal credential rejection does not throw. */
export type RefreshTokenRotationResult =
  | {
    readonly status: 'rotated'
    readonly id: string
    readonly userId: string
    readonly sessionId: string
    readonly familyId: string
  }
  | { readonly status: 'invalid' }
  | { readonly status: 'reused' }

/** Persistence owns family serialization, locked state reads, and atomic replay revocation and audit. */
export interface RefreshTokenStore {
  /**
   * Persist an initial token using the same user/family locks as rotation and revocation.
   * @param record - Initial hashed token metadata for a newly generated family.
   */
  create(record: RefreshTokenRecord): Promise<void>
  /**
   * Rotate or revoke a replayed token family in one transaction, including the replay audit.
   * @param tokenHash - Digest identifying the presented refresh credential.
   * @param replacement - New token ID, digest, and expiry; persisted identity is inherited by the store.
   * @param now - Time for expiry checks, consumption, revocation, and audit.
   * @returns The committed outcome; infrastructure failures reject and roll back all writes.
   */
  rotate(tokenHash: string, replacement: RefreshTokenReplacement, now: Date): Promise<RefreshTokenRotationResult>
  /**
   * Revoke active family records under the same locks used by rotation.
   * @param familyId - Family to revoke; a missing family is unchanged.
   */
  revokeFamily(familyId: string): Promise<void>
}

/** Opaque refresh-token lifecycle with reuse detection. */
export class RefreshTokenService {
  constructor(
    private readonly store: RefreshTokenStore,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 30 * 24 * 60 * 60_000,
  ) {}

  /**
   * Persist the first refresh-token hash in a new family.
   * @param userId - Account owning the token.
   * @param sessionId - Session associated with the family.
   * @returns The raw token, family ID, and stored record ID; persistence failures reject.
   */
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

  /**
   * Request atomic rotation; the store revokes the family and audits any detected replay.
   * @param token - Raw refresh credential whose hash identifies the stored record.
   * @returns The replacement credential and owner IDs, or null for unknown, revoked, expired, or already-used tokens.
   * @throws When persistence or the replay audit fails; normal concurrent replay returns null.
   */
  async rotate(token: string): Promise<{ token: string; familyId: string; id: string; userId: string; sessionId: string } | null> {
    const now = this.now()
    const replacementToken = createOpaqueToken(48)
    const replacement = {
      id: randomUUID(),
      tokenHash: hashToken(replacementToken),
      expiresAt: new Date(now.getTime() + this.ttlMs),
    } satisfies RefreshTokenReplacement
    const result = await this.store.rotate(hashToken(token), replacement, now)
    if (result.status !== 'rotated') return null
    return {
      token: replacementToken,
      familyId: result.familyId,
      id: result.id,
      userId: result.userId,
      sessionId: result.sessionId,
    }
  }

  /**
   * Revoke a token family when its owning session is no longer valid.
   * @param familyId - Family whose active token records must be revoked.
   */
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

/**
 * Raised when an access token fails parsing, signature, claim, or lifetime validation.
 */
export class AccessTokenInvalidError extends Error {
  /**
   * Stable identifier for a rejected access token.
   */
  readonly code = 'ACCESS_TOKEN_INVALID'

  constructor() {
    super('Access token is invalid or expired')
    this.name = 'AccessTokenInvalidError'
  }
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new AccessTokenInvalidError()
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Create an EdDSA JWT containing user and session IDs with no email or password fields.
 * @param input - User ID, session ID, and explicit scopes to include in claims.
 * @param options - Signing key, issuer, audience, optional clock in milliseconds, and TTL in seconds.
 * @returns The signed JWT; its default lifetime is ten minutes.
 * @throws For a TTL outside integer range 300–900 seconds or signing failure.
 */
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

/**
 * Verify an EdDSA JWT, its issuer and audience, required claims, and time limits.
 * @param token - Serialized JWT from an official client.
 * @param options - Verification key, expected issuer and audience, and optional clock in milliseconds.
 * @returns Verified claims; callers must still validate the persisted session and resolve workspace identity.
 * @throws {@link AccessTokenInvalidError} for invalid tokens; cryptographic key errors may also propagate.
 */
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
  if (!isJwtParts(parts)) throw new AccessTokenInvalidError()
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = parseJson(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
  if (!isJsonObject(header) || header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new AccessTokenInvalidError()
  const validSignature = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
    options.publicKey,
    Buffer.from(encodedSignature, 'base64url'),
  )
  if (!validSignature) throw new AccessTokenInvalidError()
  const claims = parseJson(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  if (!isJsonObject(claims) || typeof claims.iss !== 'string' || typeof claims.aud !== 'string'
    || claims.iss !== options.issuer || claims.aud !== options.audience
    || typeof claims.sub !== 'string' || typeof claims.sid !== 'string'
    || typeof claims.jti !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number'
    || !Array.isArray(claims.scope)
    || claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp - claims.iat > 900) {
    throw new AccessTokenInvalidError()
  }
  const scopeValues: unknown[] = claims.scope
  const scope = scopeValues.map((value) => {
    if (typeof value !== 'string') throw new AccessTokenInvalidError()
    return value
  })
  return {
    iss: claims.iss, aud: claims.aud, sub: claims.sub, sid: claims.sid,
    jti: claims.jti, iat: claims.iat, exp: claims.exp, scope,
  }
}

// String.split produces a dense array, so a three-part JWT has all three strings.
function isJwtParts(parts: string[]): parts is [string, string, string] {
  return parts.length === 3
}

function cryptoRandomUuid(): string {
  return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-4$3-8$4-$5')
}

export { PostgresAuthStore, PostgresRefreshTokenStore } from './postgres.ts'
