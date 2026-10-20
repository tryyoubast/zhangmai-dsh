import { describe, expect, it } from 'vitest'
import { assertRuntimeRoleMembership, createDatabase } from '../src/database.ts'

describe('createDatabase', () => {
  it('creates a typed client without connecting until a query is issued', async () => {
    const client = createDatabase({
      url: 'postgresql://localhost/dsh',
      maxConnections: 1,
      idleTimeoutMs: 100,
      connectionTimeoutMs: 100,
      applicationName: 'dsh-test',
      runtimeRole: 'dsh_app_runtime',
    })
    expect(client.db).toBeDefined()
    await client.close()
  })

  it('rejects JavaScript callers that pass the deployment role to the runtime pool', async () => {
    const config = {
      url: 'postgresql://localhost/dsh',
      maxConnections: 1,
      idleTimeoutMs: 100,
      connectionTimeoutMs: 100,
      applicationName: 'dsh-test',
      runtimeRole: 'dsh_migrator',
    } as unknown as Parameters<typeof createDatabase>[0]
    let client: ReturnType<typeof createDatabase> | undefined
    let error: unknown
    try {
      client = createDatabase(config)
    } catch (caught) {
      error = caught
    }
    await client?.close()
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('runtime role')
  })

  it('rejects runtime logins that inherit database roles beyond the selected runtime role', () => {
    expect(() => assertRuntimeRoleMembership(['dsh_app_runtime'], ['dsh_app_runtime'], 'dsh_app_runtime'))
      .not.toThrow()
    expect(() => assertRuntimeRoleMembership(
      ['dsh_app_runtime'], ['dsh_app_runtime', 'dsh_readonly'], 'dsh_app_runtime',
    )).toThrow('PostgreSQL login cannot inherit roles outside its selected dsh_* role')
  })
})
