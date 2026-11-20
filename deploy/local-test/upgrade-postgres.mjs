/** Prepare a new disposable 0019 database, then test the forward upgrade with restricted credentials. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { Client } = createRequire(new URL('../../packages/database/database-postgres/package.json', import.meta.url))('pg')
const host = process.env.DSH_NOVEL_DATABASE_HOST ?? 'postgres'
if (host !== 'postgres') throw new Error('Upgrade regressions require the isolated Compose postgres service')
const directory = process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets'
const secret = async name => (await readFile(join(directory, `${name}-password`), 'utf8')).trim()
const database = `dsh_publication_upgrade_${randomUUID().replaceAll('-', '')}_test`
let phase = 'database creation'
const endpoint = async (login, name) => {
  const value = new URL(`postgresql://${login}@${host}/${database}`)
  value.password = await secret(name)
  return value.href
}

async function run() {
  const bootstrap = new Client({ host, database: 'postgres', user: 'staging_admin', password: await secret('postgres') })
  await bootstrap.connect()
  try { await bootstrap.query(`CREATE DATABASE "${database}"`) } finally { await bootstrap.end() }
  phase = 'DBA baseline and ownership bootstrap'
  const administrator = new Client({ host, database, user: 'staging_admin', password: await secret('postgres') })
  await administrator.connect()
  try {
    await administrator.query(await readFile(new URL('../../packages/database/database-postgres/migrations/0001_auth_workspace_novel_ai.sql', import.meta.url), 'utf8'))
    await administrator.query(await readFile(new URL('../../packages/database/database-postgres/scripts/bootstrap-migrator-ownership.sql', import.meta.url), 'utf8'))
    await administrator.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`)
    await administrator.query(`GRANT CONNECT ON DATABASE "${database}" TO staging_migrator,staging_app,staging_worker,staging_service`)
  } finally { await administrator.end() }

  // A private package copy gives the controlled runner an immutable 0019 journal without editing repository history.
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-publication-upgrade-'))
  phase = 'private 0019 migration package preparation'
  await mkdir(join(temporary, 'lib'))
  await cp(new URL('../../packages/database/database-postgres/lib/index.js', import.meta.url), join(temporary, 'lib/index.js'))
  await cp(new URL('../../packages/database/database-postgres/migrations', import.meta.url), join(temporary, 'migrations'), { recursive: true })
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ type: 'module', private: true }))
  await symlink(new URL('../../packages/database/database-postgres/node_modules', import.meta.url).pathname, join(temporary, 'node_modules'), 'dir')
  const journalPath = join(temporary, 'migrations/meta/_journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  journal.entries = journal.entries.slice(0, 19)
  await writeFile(journalPath, JSON.stringify(journal))
  const { migrateDatabase } = await import(pathToFileURL(join(temporary, 'lib/index.js')).href)
  const migrationUrl = await endpoint('staging_migrator', 'migrator')
  phase = 'controlled migration through 0019'
  await migrateDatabase(migrationUrl)

  const environment = {
    ...process.env,
    DATABASE_TEST_URL: await endpoint('staging_app', 'app'),
    DATABASE_APP_TEST_URL: await endpoint('staging_app', 'app'),
    DATABASE_MIGRATION_URL: migrationUrl,
    DATABASE_SERVICE_TEST_URL: await endpoint('staging_service', 'service'),
    DATABASE_WORKER_TEST_URL: await endpoint('staging_worker', 'worker'),
  }
  console.log(`${database}: restricted 0019 upgrade fixture prepared; database retained for evidence`)
  phase = 'restricted forward upgrade tests'
  await new Promise((settle, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.publication-upgrade-postgres.config.ts'], {
      stdio: 'inherit', env: environment,
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? settle() : reject(new Error('Forward upgrade regression failed')))
  })
}

try { await run() } catch {
  console.error(`Publication upgrade regression failed during ${phase}; isolated database and audit evidence are preserved.`)
  process.exitCode = 1
}
