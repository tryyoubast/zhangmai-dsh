import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { assertRuntimeRoleMembership, createDatabase } from '../src/database.ts'

const runtimeConfig = {
  url: 'postgresql://localhost/dsh',
  maxConnections: 1,
  idleTimeoutMs: 100,
  connectionTimeoutMs: 100,
  applicationName: 'dsh-test',
  runtimeRole: 'dsh_app_runtime',
} as const

function roleRows(statement: string): object[] {
  if (statement.includes('login.rolsuper')) {
    return [{ rolsuper: false, rolbypassrls: false, role_name: 'dsh_app_runtime', is_member: true }]
  }
  if (statement.includes('inherited.rolname')) return [{ role_name: 'dsh_app_runtime' }]
  if (statement === 'SELECT current_user') return [{ current_user: 'dsh_app_runtime' }]
  if (statement === 'SET ROLE "dsh_app_runtime"') return []
  throw new Error(`Unexpected initialization query: ${statement}`)
}

function rolePool(query: (statement: string) => Promise<object[]>) {
  const instances: FakeClient[] = []
  class FakeClient extends EventEmitter {
    _queryable = true
    ended = false
    statements: string[] = []

    constructor() {
      super()
      instances.push(this)
    }

    connect(callback: () => void): void {
      queueMicrotask(callback)
    }

    async query(statement: string): Promise<{ rows: object[] }> {
      this.statements.push(statement)
      return { rows: await query(statement) }
    }

    end(callback: () => void): void {
      this.ended = true
      this.emit('end')
      callback()
    }
  }

  const database = createDatabase(runtimeConfig)
  const pool = database.pool
  if (!(pool instanceof Pool)) throw new Error('Expected createDatabase to construct a pg.Pool')
  // Keep pg.Pool's real queue and onConnect dispatch while replacing its network client.
  Object.assign(pool, { Client: FakeClient })
  return { database, pool, instances }
}

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
    expect(() => {
      assertRuntimeRoleMembership(['dsh_app_runtime'], ['dsh_app_runtime'], 'dsh_app_runtime')
    }).not.toThrow()
    expect(() => {
      assertRuntimeRoleMembership(
        ['dsh_app_runtime'], ['dsh_app_runtime', 'dsh_readonly'], 'dsh_app_runtime',
      )
    }).toThrow('PostgreSQL login cannot inherit roles outside its selected dsh_* role')
  })

  it('waits for role initialization before delivering a checked-out connection', async () => {
    const login = Promise.withResolvers<undefined>()
    const activeRole = Promise.withResolvers<undefined>()
    const { database, pool, instances } = rolePool(async (statement) => {
      if (statement.includes('login.rolsuper')) await login.promise
      if (statement === 'SELECT current_user') await activeRole.promise
      return roleRows(statement)
    })
    let delivered = false
    const checkout = pool.connect().then((client) => {
      delivered = true
      return client
    })
    try {
      await setImmediate()
      expect(instances[0]?.statements).toHaveLength(1)
      expect(delivered).toBe(false)
      expect(pool.idleCount).toBe(0)

      login.resolve(undefined)
      await setImmediate()
      expect(instances[0]?.statements.at(-1)).toBe('SELECT current_user')
      expect(delivered).toBe(false)

      activeRole.resolve(undefined)
      const client = await checkout
      expect(delivered).toBe(true)
      expect(instances[0]?.statements).toHaveLength(4)
      client.release()
      expect(pool.idleCount).toBe(1)
    } finally {
      login.resolve(undefined)
      activeRole.resolve(undefined)
      try {
        const client = await checkout
        if (pool.idleCount === 0) client.release()
      } finally {
        await database.close()
      }
    }
    expect(instances[0]?.ended).toBe(true)
    expect(pool.totalCount).toBe(0)
  })

  it.each([
    { name: 'superuser login', at: 'login.rolsuper', rows: [{ rolsuper: true }], error: 'superuser or BYPASSRLS' },
    { name: 'BYPASSRLS login', at: 'login.rolsuper', rows: [{ rolbypassrls: true }], error: 'superuser or BYPASSRLS' },
    { name: 'missing login', at: 'login.rolsuper', rows: [], error: 'superuser or BYPASSRLS' },
    { name: 'wrong membership', at: 'login.rolsuper', rows: [{ is_member: false }], error: 'belong only to its selected' },
    {
      name: 'additional inherited role', at: 'inherited.rolname',
      rows: [{ role_name: 'dsh_app_runtime' }, { role_name: 'dsh_readonly' }], error: 'cannot inherit roles outside',
    },
    { name: 'wrong active role', at: 'SELECT current_user', rows: [{ current_user: 'login' }], error: 'could not assume' },
  ])('rejects and closes a connection with $name', async ({ at, rows, error }) => {
    const { database, pool, instances } = rolePool(async statement => statement.includes(at) ? rows : roleRows(statement))
    const checkout = pool.connect()
    try {
      await expect(checkout).rejects.toThrow(error)
      expect(instances).toHaveLength(1)
      expect(instances[0]?.ended).toBe(true)
      expect(pool.totalCount).toBe(0)
      expect(pool.idleCount).toBe(0)
    } finally {
      // Release an unexpectedly accepted connection; the expected rejection is asserted above.
      const client = await checkout.catch(() => undefined)
      client?.release()
      await database.close()
    }
  })

  it('propagates initialization query failures and closes the rejected connection', async () => {
    const failure = new Error('role catalog query failed')
    const { database, pool, instances } = rolePool(async () => { throw failure })
    const checkout = pool.connect()
    try {
      await expect(checkout).rejects.toBe(failure)
      expect(instances[0]?.ended).toBe(true)
      expect(pool.totalCount).toBe(0)
      expect(pool.idleCount).toBe(0)
    } finally {
      const client = await checkout.catch(() => undefined)
      client?.release()
      await database.close()
    }
  })
})
