/** Verify interrupted provisioning on a disposable PostgreSQL container with no persistent volume. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '../..')
const state = resolve(process.env.DSH_LOCAL_STATE ?? join(import.meta.dirname, '.local'))
const docker = process.platform === 'win32' && existsSync('C:/Program Files/Docker/Docker/resources/bin/docker.exe')
  ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker'
const container = `dsh-local-test-bootstrap-${randomUUID()}`

async function execute(args, input) {
  return new Promise((settle, reject) => {
    const child = spawn(docker, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.resume()
    child.once('error', reject)
    child.once('close', code => code === 0 ? settle(output) : reject(new Error('Disposable bootstrap command failed')))
    child.stdin.on('error', error => {
      // An early psql exit closes its input; its exit code reports that failure without printing SQL.
      if (error.code !== 'EPIPE') reject(error)
    })
    child.stdin.end(input)
  })
}

async function main() {
  const images = await readFile(join(import.meta.dirname, 'images.lock.env'), 'utf8')
  const image = /^DSH_POSTGRES_IMAGE=(\S+)$/mu.exec(images)?.[1]
  assert(image, 'A reviewed PostgreSQL image digest is required')
  const secretPath = join(state, 'secrets')
  try {
    await execute(['run', '--detach', '--rm', '--name', container, '--tmpfs', '/var/lib/postgresql',
      '--mount', `type=bind,source=${join(secretPath, 'postgres-password')},target=/run/secrets/postgres-password,readonly`,
      '--env', 'POSTGRES_USER=staging_admin', '--env', 'POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password', image])
    const deadline = Date.now() + 30_000
    for (;;) {
      try { await execute(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'staging_admin']); break } catch {
        if (Date.now() >= deadline) throw new Error('Disposable recovery database did not become ready')
        await pause(100)
      }
    }
    const psql = ['exec', '--interactive', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'staging_admin', '-d']
    await execute([...psql, 'postgres'], 'CREATE DATABASE dsh_staging_test;')
    await execute([...psql, 'dsh_staging_test'], await readFile(join(root, 'packages/database/database-postgres/migrations/0001_auth_workspace_novel_ai.sql'), 'utf8'))
    const provision = ['run', '--rm', '--network', `container:${container}`, '--env', 'DSH_NOVEL_DATABASE_HOST=127.0.0.1']
    for (const secret of ['postgres', 'migrator', 'auth', 'app', 'worker', 'service', 'refresh-auth', 'refresh-migrator']) {
      provision.push('--mount', `type=bind,source=${join(secretPath, `${secret}-password`)},target=/run/secrets/${secret}-password,readonly`)
    }
    provision.push('dsh-local-test-app:staging', 'node', 'deploy/local-test/provision.mjs')
    await execute(provision)
    await execute([...psql, 'dsh_staging_test'], 'REVOKE dsh_auth_runtime FROM staging_auth;')
    await execute(provision)
    const membership = await execute([...psql, 'dsh_staging_test', '-tA'], "SELECT pg_has_role('staging_auth', 'dsh_auth_runtime', 'MEMBER');")
    assert.equal(membership.trim(), 't', 'An existing login must recover its runtime-role membership')
    console.log('PASS interrupted bootstrap, runtime grant recovery and repeat provisioning')
  } finally {
    try {
      await execute(['stop', container])
    } catch (error) {
      // Only a confirmed absent container permits skipping cleanup after a failed start or external removal.
      const existing = await execute(['container', 'ls', '--all', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'])
      if (existing.trim() !== '') throw error
    }
  }
}

try { await main() } catch {
  console.error('Disposable bootstrap recovery verification failed; credentials and child output are redacted.')
  process.exitCode = 1
}
