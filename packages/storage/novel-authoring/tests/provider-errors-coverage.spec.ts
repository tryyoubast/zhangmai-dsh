import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DeepSeekNovelGenerationAdapter,
  NovelGenerationWorkflowService,
  type DraftGenerationResult,
  type NovelGenerationAdapterInput,
  type NovelGenerationWorkflowDependencies,
} from '../src/index.ts'

const input: NovelGenerationAdapterInput = {
  workspaceId: 'workspace', novelId: 'novel', generationRunId: 'run', idempotencyKey: 'retry', instruction: 'Write', context: [],
}
const workflowInput = { ...input, model: 'model', promptVersion: 'v1', sourceSessionId: 'session', limit: 0 }
const saved: DraftGenerationResult = { ...input, selectedContext: [], records: [], proposals: [] }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function adapterFor(payload: unknown) {
  return new DeepSeekNovelGenerationAdapter({ apiKey: 'secret', fetch: async () => Response.json(payload) })
}

describe('structured provider response errors', () => {
  it.each([null, [], {}, { choices: null }, { choices: [] }, { choices: [null] }, { choices: [[]] }])('rejects missing completions %j', async (payload) => {
    await expect(adapterFor(payload).generate(input)).rejects.toThrow('did not contain a completion')
  })
  it.each([undefined, null, [], 'message'])('rejects missing message %j', async (message) => {
    await expect(adapterFor({ choices: [{ message }] }).generate(input)).rejects.toThrow('did not contain a message')
  })
  it.each([undefined, null, 1, [], [null, { text: 2 }], [{ text: '' }]])('rejects absent text content %j', async (content) => {
    await expect(adapterFor({ choices: [{ message: { content } }] }).generate(input)).rejects.toThrow('did not contain JSON content')
  })
  it('rejects malformed envelope and malformed completion JSON separately', async () => {
    const adapter = new DeepSeekNovelGenerationAdapter({ apiKey: 'secret', fetch: async () => new Response('{broken') })
    await expect(adapter.generate(input)).rejects.toThrow('response was not valid JSON')
    await expect(adapterFor({ choices: [{ message: { content: '{broken' } }] }).generate(input)).rejects.toThrow('content was not valid JSON')
  })
  it.each([null, [], true])('rejects a non-object structured draft %j', async (draft) => {
    await expect(adapterFor({ choices: [{ message: { content: JSON.stringify(draft) } }] }).generate(input)).rejects.toThrow('must be a JSON object')
  })
  it.each(['records', 'proposals'] as const)('rejects a non-array %s collection', async (field) => {
    await expect(adapterFor({ choices: [{ message: { content: JSON.stringify({ [field]: {} }) } }] }).generate(input)).rejects.toThrow(`${field} must be an array`)
  })
  it('rejects an empty structured output', async () => {
    await expect(adapterFor({ choices: [{ message: { content: '{}' } }] }).generate(input)).rejects.toThrow('must contain records or proposals')
  })
  it('joins text blocks and preserves optional empty collections', async () => {
    const response = { choices: [{ message: { content: [null, { text: '{"proposals":' }, { irrelevant: true }, { text: '[{"status":"draft"}]}' }] } }] }
    await expect(adapterFor(response).generate(input)).resolves.toEqual({ records: [], proposals: [{ status: 'draft' }] })
  })
  it('uses the configured endpoint and bounds provider context without changing metadata', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => Response.json({ choices: [{ message: { content: '{"records":[{}]}' } }] }))
    const adapter = new DeepSeekNovelGenerationAdapter({ apiKey: 'secret', baseUrl: 'https://provider.invalid///', model: 'configured-model', maxContextExcerptChars: 3, fetch: fetcher })
    await adapter.generate({ ...input, context: [
      { sourceType: 'character', sourceId: 'one', status: 'draft', relevanceScore: 0, recencyScore: 0, excerpt: 'abcdef', excerptHash: 'digest', tokenCount: 7 },
      { sourceType: 'character', sourceId: 'two', status: 'published', relevanceScore: 0, recencyScore: 0 },
    ] })
    expect(fetcher).toHaveBeenCalledWith('https://provider.invalid/chat/completions', expect.objectContaining({ method: 'POST' }))
    const request = fetcher.mock.calls[0]?.[1]
    if (typeof request?.body !== 'string') throw new Error('expected JSON request body')
    expect(JSON.parse(request.body)).toMatchObject({ model: 'configured-model' })
    expect(request.body).toContain('abc')
    expect(request.body).not.toContain('abcdef')
    expect(request.body).toContain('digest')
  })
  it('aborts timed-out requests and clears the timeout', async () => {
    vi.useFakeTimers()
    const fetcher: typeof globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    })
    const pending = new DeepSeekNovelGenerationAdapter({ apiKey: 'secret', fetch: fetcher, timeoutMs: 10 }).generate(input)
    const checked = expect(pending).rejects.toThrow('request timed out')
    await vi.advanceTimersByTimeAsync(10)
    await checked
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid timing and excerpt size %s', (value) => {
    expect(() => new DeepSeekNovelGenerationAdapter({ apiKey: 'secret', timeoutMs: value })).toThrow('timeoutMs')
    expect(() => new DeepSeekNovelGenerationAdapter({ apiKey: 'secret', maxContextExcerptChars: value })).toThrow('maxContextExcerptChars')
  })
  it('requires credentials and an available fetch implementation', () => {
    expect(() => new DeepSeekNovelGenerationAdapter({ apiKey: ' ' })).toThrow('API key')
    vi.stubGlobal('fetch', undefined)
    expect(() => new DeepSeekNovelGenerationAdapter({ apiKey: 'secret' })).toThrow('fetch is required')
  })
})

describe('workflow terminal states and diagnostic failures', () => {
  function dependencies(status: 'completed' | 'failed' | 'cancelled'): NovelGenerationWorkflowDependencies {
    return {
      authoring: { createGenerationRun: async () => 'run', getGenerationRunStatus: async () => status, updateGenerationRunStatus: vi.fn(async () => undefined) },
      generation: { findPersistedResult: async () => saved, generate: vi.fn(async () => saved) },
      materialization: { materialize: vi.fn(async () => ({ records: [] })) },
    }
  }
  it.each(['failed', 'cancelled'] as const)('refuses an existing %s run without generation or writes', async (status) => {
    const deps = dependencies(status)
    await expect(new NovelGenerationWorkflowService(deps).generate(workflowInput)).rejects.toThrow(`run is ${status}`)
    expect(deps.generation.generate).not.toHaveBeenCalled()
    expect(deps.authoring.updateGenerationRunStatus).not.toHaveBeenCalled()
  })
  it.each(['generationRunId', 'workspaceId', 'novelId'] as const)('refuses completed output with a mismatching %s', async (field) => {
    const deps = dependencies('completed')
    const generation = { ...deps.generation, findPersistedResult: async () => ({ ...saved, [field]: 'other' }) }
    await expect(new NovelGenerationWorkflowService({ ...deps, generation }).generate(workflowInput)).rejects.toThrow('scope mismatch')
    expect(deps.materialization.materialize).not.toHaveBeenCalled()
  })
  it('preserves the original provider error when recording failed status also fails', async () => {
    const failure = new Error('provider unavailable')
    const transitions: string[] = []
    const workflow = new NovelGenerationWorkflowService({
      authoring: {
        createGenerationRun: async () => 'run',
        updateGenerationRunStatus: async (value) => {
          transitions.push(value.status)
          if (value.status === 'failed') throw new Error('database unavailable')
        },
      },
      generation: { findPersistedResult: async () => undefined, generate: async () => { throw failure } },
      materialization: { materialize: async () => ({ records: [] }) },
    })
    await expect(workflow.generate(workflowInput)).rejects.toBe(failure)
    expect(transitions).toEqual(['running', 'failed'])
  })
})
