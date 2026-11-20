import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DeepSeekNovelGenerationAdapter } from '@deepseek-ai/dsh-novel-authoring'
import { executeRemainingRealFlow, type ResumeHarness, type ResumeSnapshot } from '../deploy/local-test/real-resume.ts'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

it('runs fixed preparation, one simulated provider completion and durable restart checks without refunding budget', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dsh-real-flow-'))
  directories.push(state)
  await mkdir(join(state, 'evidence'))
  await writeFile(join(state, 'evidence/real-provider-budget.json'), JSON.stringify({ submitted: 1, maximum: 2, novelId: 'old' }))
  const types = ['characters', 'skills', 'locations', 'factions', 'items', 'storylines', 'outlines', 'entity_relations',
    'character_skills', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events']
  const seed: ResumeSnapshot = {
    workspaceId: 'workspace', status: 'completed', savedResults: 1, draftTargets: 14, chapterNumbers: [1],
    proposals: types.map((targetType, index) => ({ id: `p${String(index)}`, targetId: `t${String(index)}`, targetType, status: 'draft' })), context: [],
  }
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    expect(JSON.parse(await readFile(join(state, 'evidence/real-provider-budget.json'), 'utf8'))).toHaveProperty('submitted', 2)
    const body: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) as unknown : undefined
    expect(body).toMatchObject({ response_format: { type: 'json_object' } })
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [
      { targetType: 'characters', name: 'Real courier' }, { targetType: 'locations', name: 'Lantern Pier' },
      { targetType: 'chapters', chapterNo: 2, title: 'Moon Harbor continuation', summary: 'The courier arrives.' },
    ] }) } }] }), { status: 200 })
  })
  const adapter = new DeepSeekNovelGenerationAdapter({ apiKey: 'test-only', fetch: request })
  let saved: ResumeSnapshot | undefined
  const order: string[] = []
  const result = await executeRemainingRealFlow(state, {
    preflight: async () => { order.push('preflight') },
    prepareFixed: async () => { order.push('fixed'); return { workspaceId: 'workspace', novelId: 'new-novel', seedRunId: 'seed' } },
    seedSnapshot: async () => seed,
    contextPreflight: async (instruction, limit) => {
      expect(instruction).toContain('Return only JSON with records')
      expect(limit).toBe(8)
      order.push('context-preflight')
      return [{ sourceType: 'character', sourceId: 't0', rank: 0, excerptHash: 'a'.repeat(64) }]
    },
    drain: async () => { order.push('drain') }, restart: async () => { order.push('restart') },
    selectReal: async () => { order.push('real') },
    submit: async (instruction, limit) => {
      expect(limit).toBe(8)
      expect(instruction).toContain('Moon Harbor')
      const output = await adapter.generate({ workspaceId: 'workspace', novelId: 'new-novel', generationRunId: 'real-run', idempotencyKey: 'one-real', instruction, context: [] })
      saved = { workspaceId: 'workspace', status: 'completed', savedResults: 1, draftTargets: 3, chapterNumbers: [2],
        proposals: (output.records ?? []).map((value, index) => ({ id: `real-p${String(index)}`, targetId: `real-t${String(index)}`, targetType: String(value.targetType), status: 'draft' })),
        context: [{ sourceType: 'character', sourceId: 't0', rank: 0, excerptHash: 'a'.repeat(64) }] }
      order.push('submit')
      return 'real-run'
    },
    generatedSnapshot: async () => { if (saved === undefined) throw new Error('no durable result'); return saved },
    restore: async () => { order.push('restore') },
  })
  expect(result).toMatchObject({ seedRunId: 'seed', runId: 'real-run', preparationProvider: 'fixed-model' })
  expect(request).toHaveBeenCalledOnce()
  expect(order).toEqual(['preflight', 'fixed', 'drain', 'restart', 'context-preflight', 'real', 'submit', 'drain', 'restart', 'restore'])
})

async function recoveryFixture() {
  const state = await mkdtemp(join(tmpdir(), 'dsh-real-recovery-'))
  directories.push(state)
  await mkdir(join(state, 'evidence'))
  await writeFile(join(state, 'evidence/real-provider-budget.json'), JSON.stringify({ submitted: 1, maximum: 2 }))
  const seed: ResumeSnapshot = {
    workspaceId: 'workspace', status: 'completed', savedResults: 1, draftTargets: 14, chapterNumbers: [1],
    proposals: Array.from({ length: 14 }, (_, index) => ({ id: `p${String(index)}`, targetId: `t${String(index)}`, targetType: `type${String(index)}`, status: 'draft' })), context: [],
  }
  const generated: ResumeSnapshot = { ...seed, draftTargets: 3, chapterNumbers: [2],
    proposals: ['characters', 'locations', 'chapters'].map(targetType => ({ id: targetType, targetId: targetType, targetType, status: 'draft' })),
    context: [{ sourceType: 'characters', sourceId: 't0', rank: 1, excerptHash: 'a'.repeat(64) }],
  }
  const submit = vi.fn(async () => 'real'), restore = vi.fn(async () => {})
  const harness = {
    preflight: vi.fn(async () => {}),
    prepareFixed: vi.fn(async () => ({ workspaceId: 'workspace', novelId: 'novel', seedRunId: 'seed' })),
    seedSnapshot: vi.fn(async () => seed), drain: vi.fn(async () => {}), restart: vi.fn(async () => {}),
    contextPreflight: vi.fn(async () => generated.context),
    selectReal: vi.fn(async () => {}), submit,
    generatedSnapshot: vi.fn(async () => generated), restore,
  } satisfies ResumeHarness
  return { state, harness, seed, generated, submit, restore }
}

it.each(['empty', 'failure'] as const)('rejects %s context preflight before provider selection or budget reservation', async (failure) => {
  const { state, harness, submit, restore } = await recoveryFixture()
  harness.contextPreflight = failure === 'empty'
    ? vi.fn(async () => [])
    : vi.fn(async () => { throw new Error('retrieval unavailable') })
  await expect(executeRemainingRealFlow(state, harness)).rejects.toBeDefined()
  expect(harness.contextPreflight).toHaveBeenCalledWith(expect.stringContaining('Return only JSON with records'), 8)
  expect(harness.selectReal).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(restore).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(state, 'evidence/real-provider-budget.json'), 'utf8'))).toHaveProperty('submitted', 1)
})

it('reports failed persistence stage and retained run locators rather than an overall success', async () => {
  const { state, harness, generated } = await recoveryFixture()
  harness.generatedSnapshot = vi.fn(async () => ({ ...generated, context: [] }))
  await expect(executeRemainingRealFlow(state, harness)).rejects.toMatchObject({
    name: 'ResumeFlowError', stage: 'generated-persistence',
    locators: { workspaceId: 'workspace', novelId: 'novel', seedRunId: 'seed', runId: 'real' },
  })
})

it('retains known locators when fixed worker restoration fails after a completed task', async () => {
  const { state, harness } = await recoveryFixture()
  harness.restore = vi.fn(async () => { throw new Error('configuration check failed') })
  await expect(executeRemainingRealFlow(state, harness)).rejects.toMatchObject({
    name: 'ResumeFlowError', stage: 'restoration',
    locators: { workspaceId: 'workspace', novelId: 'novel', seedRunId: 'seed', runId: 'real' },
  })
})

it.each(['reservation', 'release'] as const)('retains known locators when budget %s fails', async (failure) => {
  const { state, harness, submit, restore } = await recoveryFixture()
  const budgetPath = join(state, 'evidence/real-provider-budget.json')
  if (failure === 'reservation') harness.selectReal = vi.fn(async () => {
    await rename(budgetPath, `${budgetPath}.original`)
    await mkdir(budgetPath)
  })
  else harness.restore = vi.fn(async () => {
    await restore()
    const lockPath = join(state, 'evidence/real-provider-budget.lock')
    await rename(lockPath, `${lockPath}.original`)
  })
  await expect(executeRemainingRealFlow(state, harness)).rejects.toMatchObject({
    name: 'ResumeFlowError', stage: 'budget-lease',
    locators: { workspaceId: 'workspace', novelId: 'novel', seedRunId: 'seed', ...(failure === 'release' ? { runId: 'real' } : {}) },
  })
  expect(restore).toHaveBeenCalledOnce()
  if (failure === 'reservation') expect(submit).not.toHaveBeenCalled()
  else {
    expect(submit).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(budgetPath, 'utf8'))).toHaveProperty('submitted', 2)
  }
})

it('keeps an exhausted campaign unchanged and calls no preparation, retrieval or provider methods', async () => {
  const { state, harness } = await recoveryFixture()
  const path = join(state, 'evidence/real-provider-budget.json')
  const exhausted = JSON.stringify({ submitted: 2, maximum: 2, novelId: 'historical-novel' })
  await writeFile(path, exhausted)
  await expect(executeRemainingRealFlow(state, harness)).rejects.toThrow('exactly one remaining task')
  for (const callback of [
    harness.preflight, harness.prepareFixed, harness.contextPreflight, harness.selectReal, harness.submit, harness.restore,
  ]) {
    expect(callback).not.toHaveBeenCalled()
  }
  expect(await readFile(path, 'utf8')).toBe(exhausted)
})

it('compares proposal identity independently of database row order after restart', async () => {
  const { state, harness, seed, generated, submit } = await recoveryFixture()
  harness.seedSnapshot = vi.fn().mockResolvedValueOnce(seed).mockResolvedValue({ ...seed, proposals: [...seed.proposals].reverse() })
  harness.generatedSnapshot = vi.fn().mockResolvedValueOnce(generated)
    .mockResolvedValue({ ...generated, proposals: [...generated.proposals].reverse() })
  await expect(executeRemainingRealFlow(state, harness)).resolves.toHaveProperty('runId', 'real')
  expect(submit).toHaveBeenCalledOnce()
})

it.each(['context', 'draft', 'restart', 'chapter'] as const)('restores the fixed worker after a %s persistence check fails without refunding', async (failure) => {
  const { state, harness, generated, submit, restore } = await recoveryFixture()
  if (failure === 'context') harness.generatedSnapshot = vi.fn().mockResolvedValueOnce(generated)
    .mockResolvedValue({ ...generated, context: [{ ...generated.context[0], excerptHash: 'b'.repeat(64) }] })
  if (failure === 'draft') harness.generatedSnapshot = vi.fn().mockResolvedValue({ ...generated, proposals: generated.proposals.map(proposal => ({ ...proposal, status: 'published' })) })
  if (failure === 'restart') harness.restart = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('restart unavailable'))
  if (failure === 'chapter') harness.generatedSnapshot = vi.fn().mockResolvedValue({ ...generated, chapterNumbers: [1] })
  await expect(executeRemainingRealFlow(state, harness)).rejects.toBeDefined()
  expect(submit).toHaveBeenCalledOnce()
  expect(restore).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(state, 'evidence/real-provider-budget.json'), 'utf8'))).toHaveProperty('submitted', 2)
})
