/** Load pg from the database package that owns the driver dependency. */
import { createRequire } from 'node:module'

/** Minimal driver surface needed by the regression's migration/control connection. */
export interface TestPgClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row extends object = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>
}

/** pg is resolved from its owning package rather than relying on a hoisted workspace dependency. */
export const TestPgClient = (createRequire(new URL('../../../database/database-postgres/package.json', import.meta.url))('pg') as {
  Client: new (config: { connectionString: string }) => TestPgClient
}).Client
