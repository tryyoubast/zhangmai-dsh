import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

function mapping(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected workflow mapping')
  return value as Record<string, unknown>
}

describe('required local staging acceptance in PR CI', () => {
  it('runs the keyless Compose flow without credentials and preserves teardown on failure', () => {
    const workflow = mapping(load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8')))
    const jobs = mapping(workflow.jobs)
    const staging = mapping(jobs['local-staging'])
    expect(staging['runs-on']).toBe('ubuntu-24.04')
    expect(staging.if).toBeUndefined()
    expect(staging['continue-on-error']).toBeUndefined()
    expect(staging.env).toBeUndefined()
    const steps: unknown = staging.steps
    if (!Array.isArray(steps)) throw new TypeError('Staging job must define steps')
    const commands = steps.map(mapping).filter(step => typeof step.run === 'string')
    expect(commands).toContainEqual(expect.objectContaining({ run: 'pnpm run staging:init' }))
    expect(commands).toContainEqual(expect.objectContaining({ run: 'pnpm run staging:up' }))
    expect(commands).toContainEqual(expect.objectContaining({ run: 'pnpm run staging:test' }))
    expect(commands).toContainEqual(expect.objectContaining({ run: 'pnpm run staging:down', if: 'always()' }))
    expect(JSON.stringify(staging)).not.toContain('secrets.')
    expect(JSON.stringify(staging)).not.toContain('staging:test:real')
    expect(mapping(jobs['all-checks-passed']).needs).toContain('local-staging')
  })
})
