import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '..')

it('refuses real model acceptance without a locally injected key before making requests', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dsh-real-acceptance-'))
  try {
    await execute(process.execPath, [join(root, 'deploy/local-test/manage.mjs'), 'init', '--state-dir', state])
    const result: unknown = await execute(process.execPath, ['--import', 'tsx/esm', join(root, 'deploy/local-test/acceptance.ts'), '--real', '--state-dir', state], { cwd: root })
      .catch((error: unknown) => error)
    if (!(result instanceof Error) || !('stderr' in result) || typeof result.stderr !== 'string') throw new Error('Expected a missing-key failure')
    expect(result.stderr).toContain('Real acceptance requires a key in the local deepseek-api-key secret')
    expect(await readFile(join(state, 'secrets/deepseek-api-key'), 'utf8')).toBe('')
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})

it('rejects mock acceptance under an existing real lease before worker changes or report writes', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dsh-mock-lease-'))
  try {
    await execute(process.execPath, [join(root, 'deploy/local-test/manage.mjs'), 'init', '--state-dir', state])
    await writeFile(join(state, 'local-ca.crt'), 'unused while locked')
    const lock = 'unconfirmed existing owner', report = '{"original":"mock"}'
    await writeFile(join(state, 'evidence/real-provider-budget.lock'), lock)
    await writeFile(join(state, 'evidence/mock-acceptance.json'), report)
    const called = join(state, 'unexpected-docker-call'), preload = join(state, 'no-docker.mjs')
    await writeFile(preload, `import childProcess from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
childProcess.execFile = () => {writeFileSync(${JSON.stringify(called)}, 'called'); throw new Error('Unexpected Docker call')}
syncBuiltinESMExports()
`)
    await expect(execute(process.execPath, ['--import', pathToFileURL(preload).href, '--import', 'tsx/esm',
      join(root, 'deploy/local-test/acceptance.ts'), '--state-dir', state], { cwd: root })).rejects.toHaveProperty('stderr',
      'Real acceptance budget is locked or unavailable; inspect the existing lock before manual recovery\n')
    await expect(access(called)).rejects.toBeDefined()
    expect(await readFile(join(state, 'evidence/mock-acceptance.json'), 'utf8')).toBe(report)
    expect(await readFile(join(state, 'evidence/real-provider-budget.lock'), 'utf8')).toBe(lock)
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})

it('preserves the first real failure report when an existing budget rejects an ordinary rerun', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dsh-real-report-'))
  try {
    await execute(process.execPath, [join(root, 'deploy/local-test/manage.mjs'), 'init', '--state-dir', state])
    await writeFile(join(state, 'secrets/deepseek-api-key'), 'test-only-key')
    await writeFile(join(state, 'local-ca.crt'), 'unused because the existing budget rejects the run')
    const budget = JSON.stringify({ submitted: 1, maximum: 2, novelId: 'original-novel' })
    const report = JSON.stringify({ mode: 'real', scenarios: [{ scenario: 'first task', status: 'failed' }] })
    await writeFile(join(state, 'evidence/real-provider-budget.json'), budget)
    await writeFile(join(state, 'evidence/real-acceptance.json'), report)
    await expect(execute(process.execPath, ['--import', 'tsx/esm', join(root, 'deploy/local-test/acceptance.ts'), '--real', '--state-dir', state], { cwd: root })).rejects.toBeDefined()
    expect(await readFile(join(state, 'evidence/real-provider-budget.json'), 'utf8')).toBe(budget)
    expect(await readFile(join(state, 'evidence/real-acceptance.json'), 'utf8')).toBe(report)
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})
