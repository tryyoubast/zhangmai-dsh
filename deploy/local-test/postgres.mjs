/** Run non-skipping regressions with separate restricted logins for each runtime role. */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const directory = process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets'
const host = process.env.DSH_NOVEL_DATABASE_HOST ?? 'postgres'
if (host !== 'postgres') throw new Error('Compose regressions must target the isolated postgres service')
const staging = process.argv.includes('--staging')
const database = staging ? 'dsh_staging_test' : 'dsh_refresh_test'
const connection = async (login, name) => `postgresql://${login}:${encodeURIComponent((await readFile(`${directory}/${name}-password`, 'utf8')).trim())}@${host}:5432/${database}`
const jobs = staging
  ? [
      ['vitest.staging-postgres.config.ts', 'staging_worker', 'worker'],
      ['vitest.workspace-postgres.config.ts', 'staging_app', 'app'],
      ['vitest.publication-postgres.config.ts', 'staging_app', 'app'],
    ]
  : [['vitest.postgres.config.ts', 'refresh_auth', 'refresh-auth']]

async function run(config, runtimeLogin, runtimeSecret) {
  const env = {
    ...process.env,
    DATABASE_TEST_URL: await connection(runtimeLogin, runtimeSecret),
    DATABASE_MIGRATION_URL: await connection(staging ? 'staging_migrator' : 'refresh_migrator', staging ? 'migrator' : 'refresh-migrator'),
    ...(staging && runtimeSecret === 'app' ? {
      DATABASE_SERVICE_TEST_URL: await connection('staging_service', 'service'),
      DATABASE_WORKER_TEST_URL: await connection('staging_worker', 'worker'),
    } : {}),
  }
  await new Promise((settle, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config], { stdio: 'inherit', env })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) settle()
      else reject(new Error('Restricted PostgreSQL regression failed'))
    })
  })
}

try {
  for (const [config, login, secret] of jobs) await run(config, login, secret)
} catch {
  console.error('Restricted PostgreSQL regression could not complete; credentials are redacted.')
  process.exitCode = 1
}
