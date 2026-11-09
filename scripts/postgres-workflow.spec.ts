import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected workflow mapping')
  return value as Record<string, unknown>
}

describe('PostgreSQL refresh concurrency workflow', () => {
  it('runs PostgreSQL 18 on every PR as a required independent job', () => {
    const workflow = record(load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8')))
    const jobs = record(workflow.jobs)
    const job = record(jobs['postgres-refresh'])
    expect(job.name).toBe('postgres 18 / refresh token concurrency')
    expect(job['runs-on']).toBe('ubuntu-24.04')
    expect(job.if).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    expect(record(jobs['all-checks-passed']).needs).toContain('postgres-refresh')
    const postgres = record(record(job.services).postgres)
    expect(postgres.image).toBe('postgres:18')
    expect(postgres.ports).toEqual(['5432:5432'])
    expect(postgres.options).toContain('pg_isready')
  })

  it('provisions an isolated database before running the non-skipping test command', () => {
    const workflow = record(load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8')))
    const job = record(record(workflow.jobs)['postgres-refresh'])
    const env = record(job.env)
    const runtime = new URL(String(env.DATABASE_TEST_URL))
    const migration = new URL(String(env.DATABASE_MIGRATION_URL))
    expect(runtime.pathname).toMatch(/test/)
    expect(runtime.pathname).toBe(migration.pathname)
    expect(runtime.username).not.toBe(migration.username)
    expect(runtime.username).not.toBe('postgres')
    expect(migration.username).not.toBe('postgres')
    expect(new URL(String(env.TEST_DATABASE_BOOTSTRAP_URL)).pathname).toBe(runtime.pathname)
    if (!Array.isArray(job.steps)) throw new Error('Expected workflow steps')
    const steps = job.steps.map(record)
    const commands = steps.map(step => step.run).filter((command): command is string => typeof command === 'string')
    const provision = 'pnpm exec tsx packages/identity/user-auth/tests-postgres/provision.ts'
    expect(commands).toContain('pnpm install --frozen-lockfile')
    expect(commands.indexOf(provision)).toBeGreaterThan(commands.indexOf('pnpm install --frozen-lockfile'))
    expect(commands.indexOf('pnpm run test:postgres')).toBeGreaterThan(commands.indexOf(provision))
    expect(steps.every(step => step.if === undefined && step['continue-on-error'] === undefined)).toBe(true)
    expect(commands.join('\n')).not.toContain('.env')
    const manifest: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'))
    expect(record(record(manifest).scripts)['test:postgres']).toBe('vitest run --config vitest.postgres.config.ts')
  })
})
