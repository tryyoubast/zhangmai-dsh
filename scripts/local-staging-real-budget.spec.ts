import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRemainingRealAcceptance, withRealBudget } from '../deploy/local-test/real-budget.ts'

const temporary: string[] = []
const original = { submitted: 1, maximum: 2, novelId: 'first-failed-novel', extraHistory: { retained: true } }
async function state(value: unknown = original) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-real-budget-'))
  temporary.push(directory)
  await mkdir(join(directory, 'evidence'))
  await writeFile(join(directory, 'evidence/real-provider-budget.json'), JSON.stringify(value))
  return directory
}
async function budget(directory: string) {
  return JSON.parse(await readFile(join(directory, 'evidence/real-provider-budget.json'), 'utf8')) as unknown
}
function operations() {
  return {
    preflight: vi.fn(async () => {}), prepare: vi.fn(async () => {}),
    generate: vi.fn(async () => {}), verify: vi.fn(async () => {}), restore: vi.fn(async () => {}),
  }
}
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('remaining real-provider budget', () => {
  it('reserves the final task before submission and preserves all historical fields', async () => {
    const directory = await state(), steps = operations(), order: string[] = []
    for (const name of ['preflight', 'prepare', 'verify', 'restore'] as const) steps[name].mockImplementation(async () => { order.push(name) })
    steps.generate.mockImplementation(async () => {
      expect(await budget(directory)).toEqual({ ...original, submitted: 2 })
      order.push('generate')
    })
    await runRemainingRealAcceptance(directory, steps)
    expect(order).toEqual(['preflight', 'prepare', 'generate', 'verify', 'restore'])
    expect(steps.generate).toHaveBeenCalledOnce()
    expect(await readFile(join(directory, 'evidence/real-provider-budget.json'), 'utf8')).toContain('extraHistory')
  })

  it('leaves the budget byte-for-byte intact when preflight fails', async () => {
    const directory = await state(), steps = operations()
    const before = await readFile(join(directory, 'evidence/real-provider-budget.json'), 'utf8')
    steps.preflight.mockRejectedValue(new Error('HTTP 401'))
    await expect(runRemainingRealAcceptance(directory, steps)).rejects.toThrow('HTTP 401')
    expect(await readFile(join(directory, 'evidence/real-provider-budget.json'), 'utf8')).toBe(before)
    expect(steps.prepare).not.toHaveBeenCalled()
    expect(steps.generate).not.toHaveBeenCalled()
    expect(steps.restore).toHaveBeenCalledOnce()
  })

  it('refuses an ordinary rerun before invoking any callback', async () => {
    const directory = await state(), callback = vi.fn(async () => {})
    await expect(withRealBudget(directory, false, callback)).rejects.toThrow('already exists')
    expect(callback).not.toHaveBeenCalled()
    expect(await budget(directory)).toEqual(original)
  })

  it.each([null, {}, { submitted: -1, maximum: 2 }, { submitted: 0, maximum: 2 },
    { submitted: 2, maximum: 2 }, { submitted: 1.5, maximum: 2 }, { submitted: 1, maximum: 3 }])(
    'rejects malformed or unavailable resume budgets: %j', async (value) => {
      const directory = await state(value), steps = operations()
      await expect(runRemainingRealAcceptance(directory, steps)).rejects.toThrow('budget')
      expect(steps.generate).not.toHaveBeenCalled()
      expect(steps.preflight).not.toHaveBeenCalled()
    },
  )

  it('rejects invalid JSON without replacing it', async () => {
    const directory = await state(), path = join(directory, 'evidence/real-provider-budget.json')
    await writeFile(path, '{invalid')
    await expect(runRemainingRealAcceptance(directory, operations())).rejects.toThrow('budget')
    expect(await readFile(path, 'utf8')).toBe('{invalid')
  })

  it('allows only one concurrent acceptance to acquire the budget', async () => {
    const directory = await state(), first = operations(), second = operations()
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((settle) => { entered = settle })
    const held = new Promise<void>((settle) => { release = settle })
    first.preflight.mockImplementation(async () => { entered(); await held })
    const winner = runRemainingRealAcceptance(directory, first)
    try {
      await ready
      await expect(runRemainingRealAcceptance(directory, second)).rejects.toThrow('locked')
      expect(second.restore).not.toHaveBeenCalled()
    } finally { release(); await winner }
    expect(first.generate).toHaveBeenCalledOnce()
    expect(second.generate).not.toHaveBeenCalled()
    expect(await budget(directory)).toEqual({ ...original, submitted: 2 })
  })

  it.each(['prepare', 'generate', 'verify'] as const)('restores the fixed worker after %s fails', async (stage) => {
    const directory = await state(), steps = operations()
    steps[stage].mockRejectedValue(new Error(`${stage} failed`))
    await expect(runRemainingRealAcceptance(directory, steps)).rejects.toThrow(`${stage} failed`)
    expect(steps.restore).toHaveBeenCalledOnce()
    expect(await budget(directory)).toEqual({ ...original, submitted: stage === 'prepare' ? 1 : 2 })
  })

  it('reports cleanup failure independently of the original generation failure', async () => {
    const directory = await state(), steps = operations()
    steps.generate.mockRejectedValue(new Error('generation failed'))
    steps.restore.mockRejectedValue(new Error('private infrastructure detail'))
    await expect(runRemainingRealAcceptance(directory, steps)).rejects.toThrow('fixed-model restoration failed')
    expect(await budget(directory)).toEqual({ ...original, submitted: 2 })
  })

  it('does not submit if an atomic budget update fails', async () => {
    const directory = await state(), steps = operations(), path = join(directory, 'evidence/real-provider-budget.json')
    steps.prepare.mockImplementation(async () => { await rename(path, `${path}.saved`); await mkdir(path) })
    await expect(runRemainingRealAcceptance(directory, steps)).rejects.toThrow()
    expect(steps.generate).not.toHaveBeenCalled()
    expect(steps.restore).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(`${path}.saved`, 'utf8'))).toEqual(original)
  })

  it('charges a reserved task after process interruption and never removes an existing lock', async () => {
    const directory = await state()
    const modulePath = resolve(import.meta.dirname, '../deploy/local-test/real-budget.ts')
    const child = promisify(execFile)
    const source = `import {withRealBudget} from ${JSON.stringify(new URL(`file:///${modulePath.replaceAll('\\', '/')}`).href)}; await withRealBudget(process.argv[1], true, async lease => { await lease.reserve(); process.exit(7) })`
    await expect(child(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source, directory], { cwd: resolve(import.meta.dirname, '..') })).rejects.toHaveProperty('code', 7)
    expect(await budget(directory)).toEqual({ ...original, submitted: 2 })
    const lock = await readFile(join(directory, 'evidence/real-provider-budget.lock'), 'utf8')
    await expect(runRemainingRealAcceptance(directory, operations())).rejects.toThrow('locked')
    expect(await readFile(join(directory, 'evidence/real-provider-budget.lock'), 'utf8')).toBe(lock)
  })
})
