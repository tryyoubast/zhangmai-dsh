/** Standard PR runner defaults and explicit failover capacity policies. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const linuxPool = ['self-hosted', 'linux', 'x64', 'vm-backup']
const windowsPool = ['self-hosted', 'dsh-win-ci', 'windows']

interface Job {
  'runs-on'?: string
  env?: Record<string, string>
  needs?: string[]
  steps?: Array<{ run?: string; shell?: string }>
  strategy?: { matrix: { include: Array<Record<string, string>> } }
}

const jobs = (load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}).jobs

// Canonical string/boolean cases have matching Actions/JavaScript semantics;
// missing context keys use the Actions empty-string value.
function evaluate(value: string, context: Record<string, string | boolean> = {}): unknown {
  if (!value.startsWith('${{')) return value
  const source = value.trim().slice(3, -2)
    .replace(/\b(?:github|vars|matrix)(?:\.[a-zA-Z_][a-zA-Z_0-9]*)+/g,
      key => JSON.stringify(context[key] ?? ''))
  return runInNewContext(source, { fromJSON: JSON.parse }, { timeout: 1000 }) as unknown
}

const trustedHead = {
  'github.repository': 'owner/repo',
  'github.event.pull_request.head.repo.full_name': 'owner/repo',
  'github.event.pull_request.head.repo.fork': false,
  'github.event.pull_request.user.login': 'maintainer',
}

describe('PR runner defaults', () => {
  it.each([
    ['node-24', 'LINUX', 'ubuntu-24.04', linuxPool, 'blacksmith-16vcpu-ubuntu-2404'],
    ['node-24-coverage', 'LINUX', 'ubuntu-24.04', linuxPool, 'blacksmith-16vcpu-ubuntu-2404'],
    ['node-24-consumers', 'LINUX', 'ubuntu-24.04', linuxPool, 'blacksmith-16vcpu-ubuntu-2404'],
    ['node-compat', 'LINUX', 'ubuntu-24.04', linuxPool, 'blacksmith-4vcpu-ubuntu-2404'],
    ['all-checks-passed', 'LINUX', 'ubuntu-24.04', linuxPool, 'blacksmith-4vcpu-ubuntu-2404'],
    ['windows-build', 'WINDOWS', 'windows-2025', windowsPool, 'blacksmith-16vcpu-windows-2025'],
    ['windows-coverage', 'WINDOWS', 'windows-2025', windowsPool, 'blacksmith-16vcpu-windows-2025'],
    ['windows-native-tests', 'WINDOWS', 'windows-2025', windowsPool, 'blacksmith-16vcpu-windows-2025'],
    ['windows-observational', 'WINDOWS', 'windows-2025', windowsPool, 'blacksmith-16vcpu-windows-2025'],
  ] as const)('%s uses standard hosting unless its platform failover is selected', (name, platform, hosted, pool, blacksmith) => {
    const job = jobs[name]!
    const selector = job['runs-on']!
    const variable = `vars.DSH_CI_FAILOVER_${platform}`
    const context = { ...trustedHead, 'matrix.runner': 'ubuntu-24.04' }
    for (const mode of ['', 'hosted', 'unexpected']) {
      expect(evaluate(selector, { ...context, [variable]: mode }), `${name} ${mode}`).toBe(hosted)
    }
    expect(evaluate(selector, { ...context, [variable]: 'blacksmith' })).toBe(blacksmith)
    expect(evaluate(selector, { ...context, [variable]: 'selfhosted' })).toEqual(pool)
    const dependabot = { ...context, 'github.event.pull_request.user.login': 'dependabot[bot]' }
    expect(evaluate(selector, { ...dependabot, [variable]: 'selfhosted' })).toBe(hosted)
    expect(evaluate(selector, { ...dependabot, [variable]: 'blacksmith' })).toBe(blacksmith)
    const otherPlatform = platform === 'LINUX' ? 'WINDOWS' : 'LINUX'
    expect(evaluate(selector, { ...context, [`vars.DSH_CI_FAILOVER_${otherPlatform}`]: 'blacksmith' })).toBe(hosted)
  })

  it('pins direct Linux jobs and every compatibility matrix row to Ubuntu 24.04', () => {
    for (const name of ['node-24-bench', 'python-sdk', 'postgres-18-auth']) {
      expect(jobs[name]!['runs-on'], name).toBe('ubuntu-24.04')
    }
    const rows = jobs['node-compat']!.strategy!.matrix.include
    expect(rows.map(row => row.node)).toEqual(['22.19', '24.9', 26])
    expect(rows.map(row => row.runner)).toEqual(['ubuntu-24.04', 'ubuntu-24.04', 'ubuntu-24.04'])
  })

  it.each([
    { 'github.event.pull_request.head.repo.full_name': 'outsider/fork' },
    { 'github.event.pull_request.head.repo.fork': true },
  ])('keeps compatibility work off persistent runners for untrusted heads: %o', (head) => {
    expect(evaluate(jobs['node-compat']!['runs-on']!, {
      ...trustedHead, ...head, 'matrix.runner': 'ubuntu-24.04', 'vars.DSH_CI_FAILOVER_LINUX': 'selfhosted',
    })).toBe('ubuntu-24.04')
  })

  it.each(['windows-build', 'windows-coverage', 'windows-native-tests', 'windows-observational'])(
    '%s executes every command with native PowerShell', (name) => {
      const commands = jobs[name]!.steps!.filter(step => step.run !== undefined)
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.every(step => step.shell === 'pwsh')).toBe(true)
    },
  )

  it('preserves the job inventory and the required verdict dependencies', () => {
    expect(Object.keys(jobs).sort()).toEqual([
      'all-checks-passed', 'node-24', 'node-24-bench', 'node-24-consumers', 'node-24-coverage', 'node-compat',
      'postgres-18-auth', 'python-runtime', 'python-sdk', 'windows-build', 'windows-coverage',
      'windows-native-tests', 'windows-observational',
    ])
    expect(jobs['all-checks-passed']!.needs).toEqual([
      'node-24', 'node-24-coverage', 'node-24-bench', 'node-24-consumers', 'node-compat',
      'python-sdk', 'python-runtime', 'windows-build', 'windows-native-tests', 'postgres-18-auth',
    ])
  })
})

describe('PR runner capacity', () => {
  it.each([
    ['node-24', 'LINUX', 'DSH_GATE_CONCURRENCY', '2', '8', '8'],
    ['node-24-coverage', 'LINUX', 'DSH_COVERAGE_MAX_WORKERS', '2', '6', '6'],
    ['node-24-coverage', 'LINUX', 'DSH_COVERAGE_PARTITIONS', '2', '4', '4'],
    ['node-24-coverage', 'LINUX', 'DSH_GATE_CONCURRENCY', '1', '3', '3'],
    ['node-24-consumers', 'LINUX', 'DSH_GATE_CONCURRENCY', '2', '10', '10'],
    ['node-24-consumers', 'LINUX', 'DSH_OXLINT_THREADS', '2', '8', '8'],
    ['node-24-consumers', 'LINUX', 'DSH_PUBLINT_CONCURRENCY', '2', '8', '8'],
    ['node-24-consumers', 'LINUX', 'DSH_WEB_SNAPSHOT_WORKERS', '2', '6', '6'],
    ['node-24-consumers', 'LINUX', 'DSH_SNAPSHOT_MAX_CONCURRENCY', '2', '32', '12'],
    ['windows-coverage', 'WINDOWS', 'DSH_COVERAGE_MAX_WORKERS', '2', '6', '6'],
    ['windows-coverage', 'WINDOWS', 'DSH_COVERAGE_PARTITIONS', '2', '4', '4'],
    ['windows-coverage', 'WINDOWS', 'DSH_GATE_CONCURRENCY', '1', '3', '3'],
    ['windows-observational', 'WINDOWS', 'DSH_GATE_CONCURRENCY', '2', '', ''],
    ['windows-observational', 'WINDOWS', 'DSH_PUBLINT_CONCURRENCY', '2', '8', '8'],
  ])('%s %s %s follows the selected capacity', (name, platform, key, standard, blacksmith, selfhosted) => {
    const budget = jobs[name]!.env![key]!
    expect(typeof budget).toBe('string')
    const variable = `vars.DSH_CI_FAILOVER_${platform}`
    for (const mode of ['', 'hosted', 'unexpected']) {
      expect(evaluate(budget, { ...trustedHead, [variable]: mode }), mode).toBe(standard)
    }
    expect(evaluate(budget, { ...trustedHead, [variable]: 'blacksmith' })).toBe(blacksmith)
    expect(evaluate(budget, { ...trustedHead, [variable]: 'selfhosted' })).toBe(selfhosted)
    expect(evaluate(budget, {
      ...trustedHead, [variable]: 'selfhosted', 'github.event.pull_request.user.login': 'dependabot[bot]',
    })).toBe(standard)
    expect(evaluate(budget, {
      ...trustedHead, [variable]: 'blacksmith', 'github.event.pull_request.user.login': 'dependabot[bot]',
    })).toBe(blacksmith)
  })

  it.each(['node-24-coverage', 'windows-coverage'])('%s retains its per-test budget', (name) => {
    expect(jobs[name]!.env).toMatchObject({ DSH_COVERAGE_TEST_TIMEOUT_MS: '90000' })
  })
})
