/** Types for restricted database clients and the trusted identity used by RLS transactions. */

/** PostgreSQL group roles accepted for application connection pools; migration roles are excluded. */
export type DatabaseRuntimeRole =
  | 'dsh_auth_runtime'
  | 'dsh_app_runtime'
  | 'dsh_worker_runtime'
  | 'dsh_service_runtime'
  | 'dsh_readonly'

/** Validated connection and pool settings resolved before runtime startup. */
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
    /** Wait for checked-out connections to return, then close the pool. */
    end(): Promise<void>
    /**
     * Check out a connection for advisory locks; the caller must release it.
     * @returns An owned connection or a rejection when checkout fails.
     */
    connect?: () => Promise<{
      /**
       * Execute SQL on this connection.
       * @param text - SQL statement, with placeholders for supplied values.
       * @param values - Values bound to statement placeholders.
       * @returns The driver's query result; SQL and connection failures reject.
       */
      query(text: string, values?: unknown[]): Promise<unknown>
      /** Return the checked-out connection to its pool. */
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
