import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected Compose mapping')
  return value as Record<string, unknown>
}

const compose = record(load(readFileSync(resolve(import.meta.dirname, '../deploy/local-test/compose.yml'), 'utf8')))
const services = record(compose.services)

describe('isolated local staging services', () => {
  it('loads reviewed immutable image defaults for every supported Compose command', () => {
    const imageLocks = readFileSync(resolve(import.meta.dirname, '../deploy/local-test/images.lock.env'), 'utf8')
    for (const name of ['NODE', 'POSTGRES', 'REDIS', 'CADDY', 'MAILPIT']) {
      expect(imageLocks).toMatch(new RegExp(`^DSH_${name}_IMAGE=[^\\s]+@sha256:[a-f0-9]{64}$`, 'mu'))
    }
    for (const file of ['manage.mjs', 'acceptance.ts']) {
      const source = readFileSync(resolve(import.meta.dirname, `../deploy/local-test/${file}`), 'utf8')
      expect(source).toContain("'--env-file', join(directory, 'images.lock.env')")
    }
  })

  it('publishes only loopback HTTPS and the test mailbox UI', () => {
    expect(compose.name).toBe('dsh-local-test')
    expect(record(services.caddy).ports).toEqual(['127.0.0.1:8443:443'])
    expect(record(services.mailpit).ports).toEqual(['127.0.0.1:8025:8025'])
    for (const name of ['api', 'worker', 'postgres', 'redis', 'model', 'provider-check', 'provision', 'regression', 'staging-regression', 'upgrade-regression']) {
      expect(record(services[name]).ports, name).toBeUndefined()
      expect(record(services[name]).privileged, name).toBeUndefined()
      expect(record(services[name])['network_mode'], name).toBeUndefined()
    }
    expect(readFileSync(resolve(import.meta.dirname, '../deploy/local-test/Caddyfile'), 'utf8')).toContain('tls internal')
  })

  it('checks the provider on the worker network with only its provider secret and a read-only live script', () => {
    const provider = record(services['provider-check'])
    expect(provider.image).toBe(record(services.model).image)
    expect(provider.build).toBeUndefined()
    expect(provider.profiles).toEqual(['tools'])
    expect(provider.networks).toEqual(record(services.worker).networks)
    expect(provider.secrets).toEqual(['deepseek-api-key'])
    expect(provider.volumes).toEqual(['./provider-check.mjs:/fixture/provider-check.mjs:ro'])
    expect(provider.command).toEqual(['node', '/fixture/provider-check.mjs'])
    expect(provider.read_only).toBe(true)
    expect(provider.depends_on).toBeUndefined()
    expect(provider.environment).toEqual({
      DSH_NOVEL_SECRET_DIRECTORY: '/run/secrets',
      DSH_NOVEL_PROVIDER_MODEL: record(record(services.worker).environment).DSH_NOVEL_PROVIDER_MODEL,
    })
  })

  it('runs current read-only inspection code without rebuilding the application image', () => {
    expect(record(services.inspection).volumes).toContain('./inspect.mjs:/workspace/deploy/local-test/inspect.mjs:ro')
    expect(record(services.inspection).read_only).toBe(true)
    expect(record(services.inspection).secrets).toEqual(['migrator-password'])
  })

  it('keeps administrator and migration secrets out of both runtime profiles', () => {
    expect(record(services.api).secrets).toEqual(['auth-password', 'app-password', 'service-password', 'redis-password',
      { source: 'access-private', target: 'access-private.pem' }, { source: 'access-public', target: 'access-public.pem' }])
    expect(record(services.worker).secrets).toEqual(['worker-password', 'redis-password', 'deepseek-api-key'])
    expect(record(services.regression).secrets).toEqual(['refresh-auth-password', 'refresh-migrator-password'])
    expect(record(services['staging-regression']).secrets).toEqual(['worker-password', 'app-password', 'service-password', 'migrator-password'])
    expect(record(services['staging-regression']).command).toEqual(['node', 'deploy/local-test/postgres.mjs', '--staging'])
    expect(record(services.api).command).toEqual(['node', 'apps/cli/lib/bin.js', '--profile', 'novel-api'])
    expect(record(services.worker).command).toEqual(['node', 'apps/cli/lib/bin.js', '--profile', 'novel-worker'])
    expect(record(services.api).read_only).toBe(true)
    expect(record(services.worker).read_only).toBe(true)
  })

  it('gives PostgreSQL regression tools ephemeral Vite caches while retaining a read-only application image', () => {
    for (const name of ['regression', 'staging-regression', 'upgrade-regression']) {
      expect(record(services[name]).read_only).toBe(true)
      expect(record(services[name]).tmpfs).toEqual([
        '/tmp',
        '/workspace/node_modules/.vite-temp:mode=1777',
        '/workspace/node_modules/.vite:mode=1777',
      ])
    }
    expect(record(services.api).tmpfs).toEqual(['/tmp'])
    expect(record(services.worker).tmpfs).toEqual(['/tmp'])
  })
})
