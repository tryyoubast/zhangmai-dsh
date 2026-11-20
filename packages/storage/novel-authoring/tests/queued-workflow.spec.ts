import { describe, expect, it, vi } from 'vitest'
import {
  NovelGenerationWorkflowService,
  assertGenerationRunTransition,
  type DraftGenerationResult,
  type GenerationRunStatus,
  type QueuedGenerationRequest,
} from '../src/index.ts'

const locator = { workspaceId: 'workspace', generationRunId: 'queued-run' }
const request: QueuedGenerationRequest = {
  ...locator, novelId: 'novel', model: 'configured', promptVersion: 'v2',
  sourceSessionId: 'browser-session', idempotencyKey: 'browser-retry', instruction: 'Saved instruction', contextLimit: 0,
}
const draft: DraftGenerationResult = {
  ...locator, novelId: request.novelId, idempotencyKey: request.idempotencyKey,
  selectedContext: [], records: [{ targetType: 'characters', name: 'Mira' }], proposals: [],
}

function fixture(initialStatus: GenerationRunStatus = 'queued') {
  let status = initialStatus
  const authoring = {
    createGenerationRun: vi.fn(async () => { throw new Error('user-request and worker identities conflict') }),
    getGenerationRunStatus: vi.fn(async (_input: typeof locator) => status),
    getQueuedGenerationRequest: vi.fn(async () => {
      if (status !== 'queued') throw new Error('generation run is already claimed or unavailable')
      assertGenerationRunTransition(status, 'running')
      status = 'running'
      return request
    }),
    updateGenerationRunStatus: vi.fn(async (input: { readonly status: GenerationRunStatus }) => {
      assertGenerationRunTransition(status, input.status)
      status = input.status
    }),
  }
  const generation = {
    generate: vi.fn(async () => draft),
    findPersistedResult: vi.fn(async () => undefined),
  }
  const enrichment = { enrich: vi.fn(async () => ({ records: [{ targetType: 'story_facts', statement: 'The gate is open' }] })) }
  const materialization = { materialize: vi.fn(async (_result: DraftGenerationResult) => ({ records: [] })) }
  const workflow = new NovelGenerationWorkflowService({ authoring, generation, enrichment, materialization })
  return { workflow, authoring, generation, enrichment, materialization }
}

describe('queued generation workflow', () => {
  it('executes only after the claim transaction has advanced the run to running', async () => {
    const deps = fixture()
    deps.generation.generate.mockImplementationOnce(async () => {
      await expect(deps.authoring.getGenerationRunStatus(locator)).resolves.toBe('running')
      return draft
    })
    await deps.workflow.executeQueued(locator)
    expect(deps.authoring.updateGenerationRunStatus).toHaveBeenCalledExactlyOnceWith({ ...locator, status: 'completed' })
  })

  it('executes the claimed browser request without recreating its run or changing its request identity', async () => {
    const deps = fixture()
    const result = await deps.workflow.executeQueued(locator)
    expect(deps.authoring.getQueuedGenerationRequest).toHaveBeenCalledExactlyOnceWith(locator)
    expect(deps.authoring.createGenerationRun).not.toHaveBeenCalled()
    expect(deps.generation.generate).toHaveBeenCalledExactlyOnceWith({
      ...locator, novelId: 'novel', instruction: 'Saved instruction', limit: 0, idempotencyKey: 'browser-retry',
    })
    expect(deps.enrichment.enrich).toHaveBeenCalledExactlyOnceWith({ generation: draft, context: [] })
    expect(result.runId).toBe('queued-run')
    expect(result.generation.records).toHaveLength(2)
    expect(deps.materialization.materialize).toHaveBeenCalledExactlyOnceWith(result.generation)
    expect(deps.authoring.updateGenerationRunStatus).toHaveBeenCalledExactlyOnceWith({ ...locator, status: 'completed' })
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('does not claim, bill, or rematerialize a duplicate %s message', async (status) => {
    const deps = fixture(status)
    await expect(deps.workflow.executeQueued(locator)).rejects.toThrow(`generation run is ${status}`)
    expect(deps.authoring.getQueuedGenerationRequest).not.toHaveBeenCalled()
    expect(deps.authoring.createGenerationRun).not.toHaveBeenCalled()
    expect(deps.generation.generate).not.toHaveBeenCalled()
    expect(deps.generation.findPersistedResult).not.toHaveBeenCalled()
    expect(deps.materialization.materialize).not.toHaveBeenCalled()
    expect(deps.authoring.updateGenerationRunStatus).not.toHaveBeenCalled()
  })

  it('leaves a completed first delivery unchanged when its message is delivered again', async () => {
    const deps = fixture()
    await deps.workflow.executeQueued(locator)
    await expect(deps.workflow.executeQueued(locator)).rejects.toThrow('generation run is completed')
    expect(deps.generation.generate).toHaveBeenCalledTimes(1)
    expect(deps.materialization.materialize).toHaveBeenCalledTimes(1)
  })

  it('does not generate or write failure state when a claim belongs to another worker', async () => {
    const deps = fixture('running')
    deps.authoring.getQueuedGenerationRequest.mockRejectedValueOnce(new Error('generation run is already claimed or unavailable'))
    await expect(deps.workflow.executeQueued(locator)).rejects.toThrow('already claimed')
    expect(deps.generation.generate).not.toHaveBeenCalled()
    expect(deps.authoring.updateGenerationRunStatus).not.toHaveBeenCalled()
  })

  it.each([{ workspaceId: 'other' }, { generationRunId: 'other' }])('rejects a mismatched claimed request %j before generation', async (override) => {
    const deps = fixture()
    deps.authoring.getQueuedGenerationRequest.mockResolvedValueOnce({ ...request, ...override })
    await expect(deps.workflow.executeQueued(locator)).rejects.toThrow('generation request scope mismatch')
    expect(deps.generation.generate).not.toHaveBeenCalled()
    expect(deps.authoring.updateGenerationRunStatus).not.toHaveBeenCalled()
  })

  it('preserves partial materialization and stores only stable failure diagnostics', async () => {
    const deps = fixture()
    const savedTargets: string[] = []
    const failure = new Error('provider key must never enter run diagnostics')
    deps.materialization.materialize.mockImplementationOnce(async () => { savedTargets.push('character'); throw failure })
    await expect(deps.workflow.executeQueued(locator)).rejects.toBe(failure)
    expect(savedTargets).toEqual(['character'])
    expect(deps.authoring.updateGenerationRunStatus).toHaveBeenLastCalledWith({
      ...locator, status: 'failed', errorCode: 'GENERATION_FAILED',
      errorSummary: 'The generation provider or draft validation failed.',
    })
    await expect(deps.workflow.executeQueued(locator)).rejects.toThrow('generation run is failed')
    expect(deps.generation.generate).toHaveBeenCalledTimes(1)
  })

  it('requires claim and status readers while allowing existing synchronous-only compositions', async () => {
    const deps = fixture()
    const workflow = new NovelGenerationWorkflowService({
      authoring: {
        createGenerationRun: deps.authoring.createGenerationRun, updateGenerationRunStatus: deps.authoring.updateGenerationRunStatus,
      },
      generation: deps.generation, materialization: deps.materialization,
    })
    await expect(workflow.executeQueued(locator)).rejects.toThrow('queued generation requires claim and status readers')
    expect(deps.authoring.createGenerationRun).not.toHaveBeenCalled()
    expect(deps.generation.generate).not.toHaveBeenCalled()
  })
})
