/** Required host deployment configuration; defaults are owned by the profile patch. */
import z from '@deepseek-ai/schemastery'

/** Configuration consumed by either the API or the single active generation worker. */
export interface Config {
  /** Run the authenticated API or the single active generation worker. */
  readonly mode: 'api' | 'worker'
  /** Directory containing fixed host-owned credential filenames. */
  readonly secretDirectory: string
  /** Exact HTTPS Origin permitted for state-changing browser requests. */
  readonly origin: string
  /** Restricted PostgreSQL endpoint, login names, and pool bounds. */
  readonly database: {
    /** PostgreSQL hostname. */
    readonly host: string
    /** PostgreSQL TCP port. */
    readonly port: number
    /** Provisioned database name. */
    readonly name: string
    /** Login allowed to assume only the authentication runtime role. */
    readonly authUser: string
    /** Login allowed to assume only the application runtime role. */
    readonly appUser: string
    /** Login allowed to assume only the publication service runtime role. */
    readonly serviceUser: string
    /** Login allowed to assume only the generation worker runtime role. */
    readonly workerUser: string
    /** Maximum connections in each restricted pool; at least three. */
    readonly maxConnections: number
    /** Milliseconds before an idle pooled connection is closed. */
    readonly idleTimeoutMs: number
    /** Milliseconds allowed to establish a database connection. */
    readonly connectionTimeoutMs: number
  }
  /** Redis queue endpoint, notification names, and bounded command timing. */
  readonly redis: {
    /** Redis hostname. */
    readonly host: string
    /** Redis TCP port. */
    readonly port: number
    /** Redis Stream carrying workspace and generation-run locators. */
    readonly stream: string
    /** Consumer group whose pending deliveries the active worker recovers. */
    readonly group: string
    /** Milliseconds a new-message read may block. */
    readonly blockMs: number
    /** Milliseconds between failed intake or reconnect attempts. */
    readonly retryMs: number
    /** Milliseconds allowed per Redis command; must exceed blockMs. */
    readonly commandTimeoutMs: number
    /** Milliseconds allowed to establish a Redis connection. */
    readonly connectTimeoutMs: number
  }
  /** SMTP endpoint and auth-message delivery settings. */
  readonly smtp: {
    /** SMTP hostname. */
    readonly host: string
    /** SMTP TCP port. */
    readonly port: number
    /** Sender address for verification and password-reset messages. */
    readonly from: string
    /** Milliseconds allowed for SMTP connection, greeting, and socket operations. */
    readonly timeoutMs: number
  }
  /** HTTP listener and maximum collected request body. */
  readonly server: {
    /** Loopback-only or all-interface HTTP bind address; TLS belongs to the proxy. */
    readonly host: '127.0.0.1' | '0.0.0.0'
    /** HTTP TCP port; zero requests an operating-system-assigned port. */
    readonly port: number
    /** Maximum collected API request bytes. */
    readonly maxBodyBytes: number
  }
  /** Generation provider endpoint and per-request limits. */
  readonly provider: {
    /** HTTPS provider base URL or the exact internal fixture URL. */
    readonly url: string
    /** Provider model identifier sent with each generation request. */
    readonly model: string
    /** Milliseconds allowed for one provider request. */
    readonly timeoutMs: number
    /** Maximum characters sent for each selected context excerpt. */
    readonly maxContextExcerptChars: number
  }
  /** Access-token claims, credential lifetimes, and account lock policy. */
  readonly auth: {
    /** Expected issuer claim of signed access tokens. */
    readonly issuer: string
    /** Expected audience claim of signed access tokens. */
    readonly audience: string
    /** Access-token lifetime in seconds. */
    readonly accessTtlSeconds: number
    /** Refresh-token lifetime in milliseconds. */
    readonly refreshTtlMs: number
    /** Email-verification token lifetime in milliseconds. */
    readonly verificationTtlMs: number
    /** Password-reset token lifetime in milliseconds. */
    readonly resetTtlMs: number
    /** Authentication session lifetime in milliseconds. */
    readonly sessionTtlMs: number
    /** Failed-login count that triggers the account lock. */
    readonly failedLoginThreshold: number
    /** Account lock duration in milliseconds. */
    readonly lockDurationMs: number
  }
}

const text = (): z<string> => z.string().min(1).required()
const positive = (): z<number> => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required()
const port = (): z<number> => z.number().step(1).min(1).max(65535).required()

/** Validate all deployment settings before reading secrets or opening resources. */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('api'), z.const('worker')]).required(),
  secretDirectory: text(), origin: z.string().pattern(/^https:\/\/[^/]+$/u).required(),
  database: z.object({
    host: text(), port: port(), name: text(), authUser: text(), appUser: text(), serviceUser: text(), workerUser: text(),
    maxConnections: z.number().step(1).min(3).max(128).required(), idleTimeoutMs: positive(), connectionTimeoutMs: positive(),
  }).required(),
  redis: z.object({
    host: text(), port: port(), stream: text(), group: text(), blockMs: positive(), retryMs: positive(),
    commandTimeoutMs: positive(), connectTimeoutMs: positive(),
  }).required(),
  smtp: z.object({ host: text(), port: port(), from: text(), timeoutMs: positive() }).required(),
  server: z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(), maxBodyBytes: positive(),
  }).required(),
  provider: z.object({
    url: z.string().pattern(/^(?:https:\/\/[^\s]+|http:\/\/model:8081\/v1)$/u).required(),
    model: text(), timeoutMs: positive(), maxContextExcerptChars: positive(),
  }).required(),
  auth: z.object({
    issuer: text(), audience: text(), accessTtlSeconds: positive(), refreshTtlMs: positive(),
    verificationTtlMs: positive(), resetTtlMs: positive(), sessionTtlMs: positive(),
    failedLoginThreshold: positive(), lockDurationMs: positive(),
  }).required(),
})
