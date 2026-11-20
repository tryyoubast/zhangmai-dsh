import type { Config } from '../src/config.ts'

export function config(secretDirectory: string, mode: 'api' | 'worker' = 'api'): Config {
  return {
    mode, secretDirectory, origin: 'https://localhost:8443',
    database: { host: 'postgres', port: 5432, name: 'staging', authUser: 'staging_auth', appUser: 'staging_app', serviceUser: 'staging_service', workerUser: 'staging_worker', maxConnections: 4, idleTimeoutMs: 1000, connectionTimeoutMs: 1000 },
    redis: { host: 'redis', port: 6379, stream: 'dsh:novel:generation', group: 'novel-workers', blockMs: 10, retryMs: 10, commandTimeoutMs: 100, connectTimeoutMs: 100 },
    smtp: { host: 'mailpit', port: 1025, from: 'noreply@dsh.local', timeoutMs: 1000 },
    server: { host: '127.0.0.1', port: 0, maxBodyBytes: 65536 },
    provider: { url: 'http://model:8081/v1', model: 'deepseek-chat', timeoutMs: 1000, maxContextExcerptChars: 8000 },
    auth: { issuer: 'dsh-novel', audience: 'dsh-novel-official', accessTtlSeconds: 600, refreshTtlMs: 86400000, verificationTtlMs: 86400000, resetTtlMs: 3600000, sessionTtlMs: 86400000, failedLoginThreshold: 5, lockDurationMs: 900000 },
  }
}
