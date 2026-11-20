/** Bootstrap only the two disposable staging databases, then use the checked migrator for every later migration. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { migrateDatabase } from '../../packages/database/database-postgres/lib/index.js'

const { Client } = createRequire(new URL('../../packages/database/database-postgres/package.json', import.meta.url))('pg')
const secretDirectory = process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets'
const host = process.env.DSH_NOVEL_DATABASE_HOST ?? 'postgres'
if (!['postgres', '127.0.0.1'].includes(host)) throw new Error('Local staging bootstrap only accepts the isolated postgres service or loopback')
const secret = async name => (await readFile(`${secretDirectory}/${name}-password`, 'utf8')).trim()
const url = (login, password, database) => `postgresql://${login}:${encodeURIComponent(password)}@${host}:${process.env.DSH_NOVEL_DATABASE_PORT ?? '5432'}/${database}`
const literal = value => `'${value.replaceAll("'", "''")}'`

async function provision() {
  const password = await secret('postgres')
  const admin = new Client({ connectionString: url('staging_admin', password, 'postgres') })
  try {
    await admin.connect()
    for (const database of ['dsh_staging_test', 'dsh_refresh_test']) {
      if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rows.length === 0) {
        await admin.query(`CREATE DATABASE "${database}"`)
      }
    }
  } finally {
    await admin.end()
  }
  const logins = [
    ['staging_migrator', 'migrator', 'dsh_migrator'],
    ['staging_auth', 'auth', 'dsh_auth_runtime'],
    ['staging_app', 'app', 'dsh_app_runtime'],
    ['staging_worker', 'worker', 'dsh_worker_runtime'],
    ['staging_service', 'service', 'dsh_service_runtime'],
    ['refresh_auth', 'refresh-auth', 'dsh_auth_runtime'],
    ['refresh_migrator', 'refresh-migrator', 'dsh_migrator'],
  ]
  for (const database of ['dsh_staging_test', 'dsh_refresh_test']) {
    const client = new Client({ connectionString: url('staging_admin', password, database) })
    try {
      await client.connect()
      const empty = (await client.query("SELECT to_regclass('auth.users') AS relation")).rows[0].relation === null
      if (empty) {
        await client.query(await readFile(new URL('../../packages/database/database-postgres/migrations/0001_auth_workspace_novel_ai.sql', import.meta.url), 'utf8'))
      }
      if ((await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS relation")).rows[0].relation === null) {
        await client.query(await readFile(new URL('../../packages/database/database-postgres/scripts/bootstrap-migrator-ownership.sql', import.meta.url), 'utf8'))
      }
      for (const [login, name, role] of logins) {
        if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [login])).rows.length === 0) {
          await client.query(`CREATE ROLE "${login}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(await secret(name))}`)
        }
        await client.query(`GRANT "${role}" TO "${login}"`)
      }
      await client.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`)
      const allowed = database === 'dsh_staging_test'
        ? ['staging_migrator', 'staging_auth', 'staging_app', 'staging_worker', 'staging_service']
        : ['refresh_auth', 'refresh_migrator']
      await client.query(`GRANT CONNECT ON DATABASE "${database}" TO ${allowed.map(login => `"${login}"`).join(', ')}`)
    } finally {
      await client.end()
    }
    const isRefresh = database === 'dsh_refresh_test'
    await migrateDatabase(url(isRefresh ? 'refresh_migrator' : 'staging_migrator', await secret(isRefresh ? 'refresh-migrator' : 'migrator'), database))
    console.log(`${database}: checked migration journal applied`)
  }
}

try {
  await provision()
} catch {
  console.error('Local staging provisioning failed. Check the isolated database and migration journal; credentials are redacted.')
  process.exitCode = 1
}
