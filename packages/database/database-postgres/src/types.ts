/** Environment-backed connection settings for the PostgreSQL runtime. */
export type DatabaseRuntimeRole =
  | 'dsh_auth_runtime'
  | 'dsh_app_runtime'
  | 'dsh_worker_runtime'
  | 'dsh_service_runtime'
  | 'dsh_readonly'

export interface DatabaseConfig {
  /** PostgreSQL connection URL; never included in errors or logs. */
  readonly url: string
  /** Maximum number of checked-out connections. */
  readonly maxConnections: number
  /** Milliseconds before an idle pool client is closed. */
  readonly idleTimeoutMs: number
  /** Milliseconds allowed for establishing a new connection. */
  readonly connectionTimeoutMs: number
  /** PostgreSQL application name used for operational attribution. */
  readonly applicationName: string
  /** Restricted PostgreSQL group role selected for every pooled connection. */
  readonly runtimeRole: DatabaseRuntimeRole
}

/** A database client and its owned connection pool. */
export interface DatabaseClient<Database> {
  readonly db: Database
  readonly pool: {
    end(): Promise<void>
    /** Optional low-level connection seam used only for advisory locks. */
    connect?: () => Promise<{
      query(text: string, values?: unknown[]): Promise<unknown>
      release(): void
    }>
  }
  /** Close the pool after all in-flight work has completed. */
  close(): Promise<void>
}

/** Trusted identity values applied to a single PostgreSQL transaction. */
export interface RequestDatabaseContext {
  readonly userId: string
  readonly workspaceId: string
  readonly actorType: 'user' | 'agent'
  readonly agentPrincipalId?: string
}
