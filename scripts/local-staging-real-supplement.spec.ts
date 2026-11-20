import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { DeepSeekNovelGenerationAdapter } from '@deepseek-ai/dsh-novel-authoring'
import { withSupplementBudget } from '../deploy/local-test/real-budget.ts'
import { executeRealSupplement as flow, type SupplementHarness } from '../deploy/local-test/real-supplement.ts'
import { readSupplementLogin, saveSupplementLogin } from '../deploy/local-test/supplement-login.ts'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

const historical = '{"submitted":2,"maximum":2,"novelId":"historical"}\n'
const baseHash = createHash('sha256').update(historical).digest('hex')
const model = 'deepseek-flash'
const locator = { workspaceId: 'workspace', novelId: 'novel', userId: 'owner' }
const historicalCharacter = { sourceType: 'character', sourceId: 'target-1-0', rank: 0, excerptHash: 'a'.repeat(64) }
const history = [historicalCharacter]

function snapshot(chapter: number) {
  return {
    workspaceId: locator.workspaceId, status: 'completed', savedResults: 1, draftTargets: 3,
    chapterNumbers: [chapter], context: chapter === 1 ? [] : history,
    proposals: ['characters', 'locations', 'chapters'].map((targetType, index) => ({
      id: `proposal-${String(chapter)}-${String(index)}`, targetId: `target-${String(chapter)}-${String(index)}`,
      status: 'draft', targetType,
    })),
  }
}

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), 'dsh-supplement-'))
  directories.push(state)
  const original = join(state, 'evidence', 'real-provider-budget.json')
  const supplemental = join(state, 'evidence', 'real-provider-budget-supplement.json')
  await mkdir(join(state, 'evidence'))
  await writeFile(original, historical)
  const persisted = async () => JSON.parse(await readFile(supplemental, 'utf8')) as unknown
  const harness = {
    preflight: vi.fn(async () => {}), prepare: vi.fn(async () => locator),
    attach: vi.fn(async () => {}), drain: vi.fn(async () => {}), restart: vi.fn(async () => {}),
    selectReal: vi.fn(async () => {}), restore: vi.fn(async () => {}),
    contextPreflight: vi.fn(async () => history),
    submit: vi.fn(async (_instruction: string, limit: number, key: string) => {
      expect(await persisted()).toMatchObject({ submitted: limit === 0 ? 1 : 2, reservationKey: key })
      return limit === 0 ? 'seed-run' : 'next-run'
    }),
    snapshot: vi.fn(async (id: string) => snapshot(id === 'seed-run' ? 1 : 2)),
  } satisfies SupplementHarness
  return { state, original, supplemental, persisted, harness }
}

it('reserves exactly two tasks, verifies the same history after restart and preserves the original budget', async () => {
  const { state, original, persisted, harness } = await fixture()
  const result = await flow(state, false, baseHash, model, harness)
  expect(result).toMatchObject({ ...locator, seedRunId: 'seed-run', runId: 'next-run' })
  expect(harness.submit.mock.calls.map(([instruction, limit]) => [instruction.includes('Moon Harbor'), limit])).toEqual([[true, 0], [true, 8]])
  expect(harness.contextPreflight).toHaveBeenCalledWith('seed-run', harness.submit.mock.calls[1]?.[0], 8)
  expect(harness.restart).toHaveBeenCalledTimes(2)
  expect(await persisted()).toMatchObject({ maximum: 2, submitted: 2, baseBudgetSha256: baseHash })
  expect(await readFile(original, 'utf8')).toBe(historical)
  await expect(flow(state, true, baseHash, model, harness)).rejects.toThrow(/budget/i)
  expect(harness.submit).toHaveBeenCalledTimes(2)
})

it('resumes a verified seed in a fresh invocation without submitting a new seed', async () => {
  const { state, persisted, harness } = await fixture()
  harness.restart.mockRejectedValueOnce(new Error('interrupted before restart'))
  await expect(flow(state, false, baseHash, model, harness)).rejects.toMatchObject({ stage: 'seed-restart' })
  expect(await persisted()).toMatchObject({ submitted: 1, seed: { ...locator, seedRunId: 'seed-run' } })
  expect(harness.restore).toHaveBeenCalled()
  await expect(flow(state, false, baseHash, model, harness)).rejects.toThrow(/budget/i)
  await expect(flow(state, true, baseHash, model, harness)).resolves.toHaveProperty('runId', 'next-run')
  expect(harness.prepare).toHaveBeenCalledOnce()
  expect(harness.attach).toHaveBeenCalledWith(locator)
  expect(harness.submit.mock.calls.map(([, limit]) => limit)).toEqual([0, 8])
})

it('never submits a second task when the first submission has an ambiguous outcome', async () => {
  const { state, persisted, harness } = await fixture()
  harness.submit.mockRejectedValueOnce(new Error('connection lost'))
  await expect(flow(state, false, baseHash, model, harness)).rejects.toMatchObject({ stage: 'seed-submission' })
  expect(await persisted()).toMatchObject({ submitted: 1 })
  await expect(flow(state, true, baseHash, model, harness)).rejects.toThrow(/checkpoint/i)
  expect(harness.submit).toHaveBeenCalledOnce()
})

it.each(['empty', 'foreign', 'changed'] as const)('stops before reservation 2 when history is %s', async (failure) => {
  const { state, persisted, harness } = await fixture()
  if (failure === 'changed') {
    harness.snapshot.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce({ ...snapshot(1), savedResults: 0 })
  } else {
    harness.contextPreflight.mockResolvedValueOnce(failure === 'empty' ? [] : [{ ...historicalCharacter, sourceId: 'other' }])
  }
  await expect(flow(state, false, baseHash, model, harness)).rejects.toMatchObject({
    stage: failure === 'changed' ? 'seed-restart' : 'context-preflight',
  })
  expect(await persisted()).toMatchObject({ submitted: 1 })
  expect(harness.submit).toHaveBeenCalledOnce()
  expect(harness.restore).toHaveBeenCalled()
})

it('does not reserve or prepare any data after credential rejection', async () => {
  const { state, supplemental, harness } = await fixture()
  harness.preflight.mockRejectedValueOnce(new Error('401'))
  await expect(flow(state, false, baseHash, model, harness)).rejects.toMatchObject({ stage: 'preflight' })
  await expect(readFile(supplemental)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(harness.prepare).not.toHaveBeenCalled()
  expect(harness.submit).not.toHaveBeenCalled()
})

it('keeps both failure stages when the paid call and cleanup both fail', async () => {
  const { state, persisted, harness } = await fixture()
  harness.submit.mockResolvedValueOnce('seed-run').mockRejectedValueOnce(new Error('unavailable'))
  harness.restore.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cannot restore'))
  await expect(flow(state, false, baseHash, model, harness)).rejects.toMatchObject({
    stage: 'continuation-submission', restorationFailed: true,
  })
  expect(await persisted()).toMatchObject({ submitted: 2 })
})

it('refuses concurrent access and never posts when a reservation cannot be written', async () => {
  const { state, supplemental, harness } = await fixture()
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const stop = new Promise<void>((resolve) => { release = resolve })
  harness.selectReal.mockImplementationOnce(async () => {
    entered()
    await stop
    await mkdir(supplemental)
  })
  const winner = flow(state, false, baseHash, model, harness)
  const failed = expect(winner).rejects.toMatchObject({ stage: 'seed-reservation' })
  try {
    await Promise.race([ready, winner])
    await expect(flow(state, false, baseHash, model, harness)).rejects.toThrow(/lock/i)
  } finally { release(); await failed }
  expect(harness.submit).not.toHaveBeenCalled()
})

it('rejects a changed historical budget or corrupted supplemental budget before real work', async () => {
  const { state, original, supplemental, harness } = await fixture()
  await rename(original, `${original}.saved`)
  await writeFile(original, historical.trim())
  await expect(flow(state, false, baseHash, model, harness)).rejects.toThrow(/historical/i)
  await writeFile(original, historical)
  await writeFile(supplemental, '{bad json')
  await expect(flow(state, false, baseHash, model, harness)).rejects.toThrow(/budget/i)
  expect(harness.preflight).not.toHaveBeenCalled()
  expect(harness.submit).not.toHaveBeenCalled()
})

it('keeps the second reservation durable across process loss and refuses a later replay', async () => {
  const { state, persisted, supplemental, harness } = await fixture()
  await withSupplementBudget(state, false, baseHash, async (lease) => {
    await lease.reserve('first')
    await lease.saveSeed({ ...locator, seedRunId: 'seed-run', model, snapshotHash: 'a'.repeat(64), instructionHash: 'b'.repeat(64) })
  })
  const module = new URL('../deploy/local-test/real-budget.ts', import.meta.url).href
  const source = `import { withSupplementBudget } from ${JSON.stringify(module)};
    await withSupplementBudget(process.argv[1], true, process.argv[2], async lease => { await lease.reserve('second'); process.exit(23) })`
  const execute = promisify(execFile)
  await expect(execute(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source, state, baseHash]))
    .rejects.toHaveProperty('code', 23)
  expect(await persisted()).toMatchObject({ submitted: 2, reservationKey: 'second', seedReservationKey: 'first' })
  const lock = join(state, 'evidence', 'real-provider-budget.lock')
  const held = await readFile(lock, 'utf8')
  await expect(flow(state, true, baseHash, model, harness)).rejects.toThrow(/lock/i)
  expect(await readFile(lock, 'utf8')).toBe(held)
  // execFile confirmed that the owner of this test-only lock exited.
  await unlink(lock)
  const bytes = await readFile(supplemental, 'utf8')
  await expect(flow(state, true, baseHash, model, harness)).rejects.toThrow(/budget/i)
  expect(await readFile(supplemental, 'utf8')).toBe(bytes)
  expect(harness.submit).not.toHaveBeenCalled()
})

it('uses the real adapter protocol with an injected provider and the persisted initial history', async () => {
  const { state, harness, persisted } = await fixture()
  const excerpt = 'Lin guards Moon Harbor and finds a sealed letter.'
  const historical = { ...historicalCharacter, excerptHash: createHash('sha256').update(excerpt).digest('hex') }
  let first: ReturnType<typeof snapshot> | undefined, second: ReturnType<typeof snapshot> | undefined
  const fetchProvider = vi.fn<typeof fetch>(async (_url, options) => {
    const body = typeof options?.body === 'string' ? options.body : ''
    const chapter = first === undefined ? 1 : 2
    expect(body.includes(excerpt)).toBe(chapter === 2)
    expect(await persisted()).toHaveProperty('submitted', chapter)
    const records = [
      { targetType: 'characters', name: chapter === 1 ? 'Lin' : 'Lantern Courier', summary: excerpt },
      { targetType: 'locations', name: chapter === 1 ? 'Moon Harbor' : 'Lantern Pier' },
      { targetType: 'chapters', chapterNo: chapter, title: 'Moon Harbor' },
    ]
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records }) } }] }))
  })
  const adapter = new DeepSeekNovelGenerationAdapter({ apiKey: 'test-only', model, fetch: fetchProvider })
  harness.submit.mockImplementation(async (instruction, limit, key) => {
    const chapter = limit === 0 ? 1 : 2, runId = chapter === 1 ? 'seed-run' : 'next-run'
    const context = chapter === 1 ? [] : [{ ...historical, ...locator, excerpt, status: 'draft' as const,
      tokenCount: 11, recencyScore: 1, relevanceScore: 1, selectionReason: 'workspace_novel_context' }]
    const response = await adapter.generate({ ...locator, generationRunId: runId, instruction, idempotencyKey: key, context })
    expect(response.records).toHaveLength(3)
    if (chapter === 1) first = snapshot(1)
    else second = { ...snapshot(2), context: [historical] }
    return runId
  })
  harness.snapshot.mockImplementation(async (id) => {
    const saved = id === 'seed-run' ? first : second
    if (saved === undefined) throw new Error('Missing saved result')
    return saved
  })
  harness.contextPreflight.mockImplementation(async () => {
    expect(first?.proposals[0]?.targetId).toBe(historical.sourceId)
    return [historical]
  })
  await expect(flow(state, false, baseHash, model, harness)).resolves.toMatchObject({ context: [historical] })
  expect(fetchProvider).toHaveBeenCalledTimes(2)
  expect(new Set(harness.submit.mock.calls.map(([, , key]) => key)).size).toBe(2)
})

it('reopens independent staging login material without emitting it to evidence', async () => {
  const { state } = await fixture()
  const id = '9c9834a3-b211-462e-8660-42a1511eac83'
  const login = { email: `staging-${id}@test.invalid`, password: `A!9${'a'.repeat(48)}` }
  await mkdir(join(state, 'secrets'))
  await saveSupplementLogin(state, id, login)
  const file = join(state, 'secrets', `supplement-login-${id}`)
  if (process.platform === 'win32') expect(await readFile(file, 'utf8')).not.toContain(login.password)
  await expect(readSupplementLogin(state, id)).resolves.toEqual(login)
  await expect(saveSupplementLogin(state, id, login)).rejects.toMatchObject({ code: 'EEXIST' })
})
