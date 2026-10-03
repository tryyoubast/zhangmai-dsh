import { describe, expect, it, vi } from 'vitest'
import {
  DeepSeekNovelGenerationAdapter,
  GenerationMaterializationService,
  NovelGenerationWorkflowService,
  type DraftGenerationResult,
  type DraftRecordWriter,
} from '../src/index.ts'

describe('DeepSeekNovelGenerationAdapter', () => {
  it('sends bounded context and parses structured JSON without exposing the key', async () => {
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-key' })
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      expect(body.messages[1]?.content).toContain('continue the chapter')
      expect(body.messages[1]?.content).toContain('summary-1')
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ records: [{ targetType: 'characters', name: 'Lin', status: 'draft' }] }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const adapter = new DeepSeekNovelGenerationAdapter({ apiKey: 'secret-key', fetch: fetcher })
    await expect(adapter.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-1', idempotencyKey: 'idem-1',
      instruction: 'continue the chapter',
      context: [{ sourceType: 'chapter_summary', sourceId: 'summary-1', status: 'published', relevanceScore: 1, recencyScore: 1, excerpt: 'The hero enters the city.' }],
    })).resolves.toEqual({ records: [{ targetType: 'characters', name: 'Lin', status: 'draft' }], proposals: [] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects provider errors and malformed responses without echoing credentials', async () => {
    const fetcher = vi.fn(async () => new Response('provider failed', { status: 500 }))
    const adapter = new DeepSeekNovelGenerationAdapter({ apiKey: 'secret-key', fetch: fetcher })
    const failure = adapter.generate({
      workspaceId: 'w1', novelId: 'n1', generationRunId: 'run-1', idempotencyKey: 'idem-1', instruction: 'write', context: [],
    })
    await expect(failure).rejects.toThrow('DeepSeek generation request failed with HTTP 500')
    await expect(failure).rejects.not.toThrow('secret-key')
  })
})

describe('GenerationMaterializationService', () => {
  it('creates fixed draft records and proposals with deterministic idempotency keys', async () => {
    const calls: string[] = []
    const proposalPayloads: Record<string, unknown>[] = []
    const writer = {
      async createCharacterDraft(input: { readonly idempotencyKey: string }) { calls.push(`character:${input.idempotencyKey}`); return 'character-1' },
      async createSkillDraft(input: { readonly idempotencyKey: string }) { calls.push(`skill:${input.idempotencyKey}`); return 'skill-1' },
      async createCharacterSkillDraft(input: { readonly characterId: string; readonly skillId: string }) { calls.push(`link:${input.characterId}:${input.skillId}`); return 'link-1' },
      async createDraftProposal(input: { readonly targetType: string; readonly idempotencyKey: string; readonly proposedContent: Record<string, unknown> }) { calls.push(`proposal:${input.targetType}:${input.idempotencyKey}`); proposalPayloads.push(input.proposedContent); return `proposal-${calls.length}` },
    } as unknown as DraftRecordWriter
    const result: DraftGenerationResult = {
      generationRunId: 'run-1', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'generation-1', selectedContext: [],
      records: [
        { targetType: 'characters', clientKey: 'hero', name: 'Lin', summary: 'A courier' },
        { targetType: 'skills', clientKey: 'blink', name: 'Blink', summary: 'Short teleport' },
        { targetType: 'character_skills', characterRef: 'hero', skillRef: 'blink', relationType: 'knows' },
      ], proposals: [],
    }
    await expect(new GenerationMaterializationService(writer).materialize(result)).resolves.toEqual({
      records: [
        { targetType: 'characters', targetId: 'character-1', proposalId: 'proposal-2' },
        { targetType: 'skills', targetId: 'skill-1', proposalId: 'proposal-4' },
        { targetType: 'character_skills', targetId: 'link-1', proposalId: 'proposal-6' },
      ],
    })
    expect(calls).toEqual([
      'character:generation-1:0',
      'proposal:characters:generation-1:0:proposal',
      'skill:generation-1:1',
      'proposal:skills:generation-1:1:proposal',
      'link:character-1:skill-1',
      'proposal:character_skills:generation-1:2:proposal',
    ])
    expect(proposalPayloads).toEqual([
      { name: 'Lin', summary: 'A courier', attributes_jsonb: {}, attributes_schema_version: 1 },
      { name: 'Blink', summary: 'Short teleport', attributes_jsonb: {}, attributes_schema_version: 1 },
      {
        character_id: 'character-1', skill_id: 'skill-1', relation_type: 'knows', source_version_no: null,
        attributes_jsonb: {}, attributes_schema_version: 1,
      },
    ])
  })

  it('rejects unsupported update records instead of silently bypassing review', async () => {
    const writer = { createDraftProposal: vi.fn() } as unknown as DraftRecordWriter
    await expect(new GenerationMaterializationService(writer).materialize({
      generationRunId: 'run-1', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'generation-1', selectedContext: [],
      records: [{ targetType: 'characters', operation: 'update', targetId: 'character-1', name: 'Lin' }], proposals: [],
    })).rejects.toThrow('only create and link records are supported')
    expect(writer.createDraftProposal).not.toHaveBeenCalled()
  })

  it('canonicalizes relation and provenance fields to the values written by draft writers', async () => {
    const proposals: Array<{ targetType: string; proposedContent: Record<string, unknown> }> = []
    const writer = {
      async createEntityRelationDraft(input: Record<string, unknown>) {
        expect(input.sourceEntityType).toBe('characters')
        expect(input.attributes).toEqual({ hostile: true })
        return 'relation-1'
      },
      async createStoryFactDraft(input: Record<string, unknown>) {
        expect(input.sourceChapterId).toBe('chapter-1')
        expect(input.sourceChapterVersionId).toBe('version-1')
        return 'fact-1'
      },
      async createTimelineEventDraft(input: Record<string, unknown>) {
        expect(input.sourceChapterId).toBe('chapter-1')
        expect(input.sourceChapterVersionId).toBe('version-1')
        return 'event-1'
      },
      async createDraftProposal(input: { targetType: string; proposedContent: Record<string, unknown> }) {
        proposals.push(input)
        return `${input.targetType}-proposal`
      },
    } as unknown as DraftRecordWriter
    const result = await new GenerationMaterializationService(writer).materialize({
      generationRunId: 'run-1', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'generation-1', selectedContext: [],
      records: [
        { targetType: 'entity_relations', sourceEntityType: 'characters', sourceEntityId: 'character-1', targetEntityType: 'locations', targetEntityId: 'location-1', relationType: 'guards', attributes: { hostile: true } },
        { targetType: 'story_facts', factKey: 'city.open', statement: 'The gate is open', sourceChapterId: 'chapter-1', sourceChapterVersionId: 'version-1' },
        { targetType: 'timeline_events', eventKey: 'arrival', title: 'Arrival', sourceChapterId: 'chapter-1', sourceChapterVersionId: 'version-1' },
      ], proposals: [],
    })
    expect(result.records).toHaveLength(3)
    expect(proposals[0]?.proposedContent).toMatchObject({
      source_version_no: null, valid_from: null, valid_to: null,
    })
    expect(proposals[1]?.proposedContent).toMatchObject({
      source_chapter_id: 'chapter-1', source_chapter_version_id: 'version-1',
    })
    expect(proposals[2]?.proposedContent).toMatchObject({
      source_chapter_id: 'chapter-1', source_chapter_version_id: 'version-1',
    })
  })

  it('uses the same persisted payload for snake-case attributes and outlines', async () => {
    const outlineInputs: Record<string, unknown>[] = []
    const namedInputs: Record<string, unknown>[] = []
    const proposals: Array<{ targetType: string; proposedContent: Record<string, unknown> }> = []
    const writer = {
      async createOutlineDraft(input: Record<string, unknown>) {
        outlineInputs.push(input)
        return 'outline-1'
      },
      async createCharacterDraft(input: Record<string, unknown>) {
        namedInputs.push(input)
        return 'character-1'
      },
      async createDraftProposal(input: { targetType: string; proposedContent: Record<string, unknown> }) {
        proposals.push(input)
        return `${input.targetType}-proposal`
      },
    } as unknown as DraftRecordWriter

    await new GenerationMaterializationService(writer).materialize({
      generationRunId: 'run-payload', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'payload', selectedContext: [],
      records: [
        { targetType: 'outlines', name: 'Arc', content_jsonb: { beats: ['arrival'] } },
        { targetType: 'characters', name: 'Lin', attributes: { origin: 'south' }, attributes_jsonb: { origin: 'north' }, attributes_schema_version: 7 },
      ], proposals: [],
    })

    expect(outlineInputs[0]?.attributes).toEqual({ beats: ['arrival'] })
    expect(namedInputs[0]?.attributes).toEqual({ origin: 'south' })
    expect(proposals.map(({ targetType, proposedContent }) => ({ targetType, proposedContent }))).toEqual([
      { targetType: 'outlines', proposedContent: { title: 'Arc', content_jsonb: { beats: ['arrival'] } } },
      { targetType: 'characters', proposedContent: { name: 'Lin', summary: null, attributes_jsonb: { origin: 'south' }, attributes_schema_version: 1 } },
    ])
  })

  it('canonicalizes chapter provenance to the values written by the draft writer', async () => {
    const versionInputs: Record<string, unknown>[] = []
    const proposals: Array<{ targetType: string; proposedContent: Record<string, unknown> }> = []
    const writer = {
      async createChapterVersionDraft(input: Record<string, unknown>) {
        versionInputs.push(input)
        return 'version-1'
      },
      async createDraftProposal(input: { targetType: string; proposedContent: Record<string, unknown> }) {
        proposals.push(input)
        return 'proposal-1'
      },
    } as unknown as DraftRecordWriter

    await new GenerationMaterializationService(writer).materialize({
      generationRunId: 'run-chapter-version', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'chapter-version', selectedContext: [],
      records: [{
        targetType: 'chapter_versions', chapterId: 'chapter-1', versionNo: 1,
        contentSha256: 'a'.repeat(64), contentBytes: 5, contentStorageKind: 'postgres_text', contentText: 'hello',
        sourceType: 'external_import', sourceId: 'source-1',
      }], proposals: [],
    })

    expect(versionInputs[0]).not.toHaveProperty('sourceType')
    expect(versionInputs[0]).not.toHaveProperty('sourceId')
    expect(proposals[0]?.proposedContent).toEqual({
      chapter_id: 'chapter-1', version_no: 1, content_sha256: 'a'.repeat(64), content_bytes: 5,
      content_storage_kind: 'postgres_text', content_text: 'hello', content_object_key: null, summary: null,
      source_type: 'ai_generation', source_id: null,
    })
  })

  it('reuses a completed materialization for repeated generation retries', async () => {
    const calls: string[] = []
    const seen = new Set<string>()
    const mark = (key: string): void => {
      if (seen.has(key)) throw new Error(`duplicate write: ${key}`)
      seen.add(key)
    }
    const writer = {
      async createCharacterDraft(input: { readonly idempotencyKey: string }) {
        mark(`character:${input.idempotencyKey}`)
        calls.push(`character:${input.idempotencyKey}`)
        return 'character-1'
      },
      async createDraftProposal(input: { readonly idempotencyKey: string }) {
        mark(`proposal:${input.idempotencyKey}`)
        calls.push(`proposal:${input.idempotencyKey}`)
        return 'proposal-1'
      },
    } as unknown as DraftRecordWriter
    const service = new GenerationMaterializationService(writer)
    const result: DraftGenerationResult = {
      generationRunId: 'run-retry', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'generation-retry', selectedContext: [],
      records: [{ targetType: 'characters', name: 'Lin', status: 'draft' }], proposals: [],
    }

    const first = await service.materialize(result)
    const second = await service.materialize(result)

    expect(second).toBe(first)
    expect(calls).toEqual([
      'character:generation-retry:0',
      'proposal:generation-retry:0:proposal',
    ])
  })
})

describe('NovelGenerationWorkflowService', () => {
  it('moves a run through running and completed while materializing drafts', async () => {
    const transitions: string[] = []
    const workflow = new NovelGenerationWorkflowService({
      authoring: {
        async createGenerationRun() { transitions.push('create'); return 'run-1' },
        async updateGenerationRunStatus(input) { transitions.push(input.status) },
      },
      generation: {
        async findPersistedResult() { return undefined },
        async generate() {
          return { generationRunId: 'run-1', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'idem-1', selectedContext: [], records: [], proposals: [] }
        },
      },
      materialization: {
        async materialize() { transitions.push('materialize'); return { records: [] } },
      },
    })
    await expect(workflow.generate({
      workspaceId: 'w1', novelId: 'n1', model: 'deepseek-chat', promptVersion: 'v1', sourceSessionId: 'session-1',
      instruction: 'write the next chapter', limit: 4, idempotencyKey: 'idem-1',
    })).resolves.toMatchObject({ runId: 'run-1' })
    expect(transitions).toEqual(['create', 'running', 'materialize', 'completed'])
  })

  it('enriches generated chapter drafts with reviewable facts before materialization', async () => {
    let materialized: DraftGenerationResult | undefined
    const workflow = new NovelGenerationWorkflowService({
      authoring: {
        async createGenerationRun() { return 'run-enriched' },
        async updateGenerationRunStatus() {},
      },
      generation: {
        async findPersistedResult() { return undefined },
        async generate() {
          return {
            generationRunId: 'run-enriched', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'idem-enriched',
            selectedContext: [], records: [{ targetType: 'chapters', clientKey: 'chapter', chapterNo: 1, title: 'Arrival' }], proposals: [],
          }
        },
      },
      enrichment: {
        async enrich(input) {
          expect(input.generation.records).toHaveLength(1)
          return { records: [{ targetType: 'story_facts', factKey: 'city.open', statement: 'The city gate is open', status: 'draft' }], proposals: [] }
        },
      },
      materialization: {
        async materialize(result) { materialized = result; return { records: [] } },
      },
    })
    await workflow.generate({
      workspaceId: 'w1', novelId: 'n1', model: 'deepseek-chat', promptVersion: 'v1', sourceSessionId: 'session-1',
      instruction: 'write the next chapter', limit: 4, idempotencyKey: 'idem-enriched',
    })
    expect(materialized?.records).toHaveLength(2)
    expect(materialized?.records[1]).toMatchObject({ targetType: 'story_facts', status: 'draft' })
  })

  it('marks a run failed with a safe code when generation fails', async () => {
    const statuses: string[] = []
    const workflow = new NovelGenerationWorkflowService({
      authoring: {
        async createGenerationRun() { return 'run-2' },
        async updateGenerationRunStatus(input) { statuses.push(`${input.status}:${input.errorCode ?? ''}`) },
      },
      generation: {
        async findPersistedResult() { return undefined },
        async generate() { throw new Error('provider secret must not be persisted') },
      },
      materialization: { async materialize() { return { records: [] } } },
    })
    await expect(workflow.generate({
      workspaceId: 'w1', novelId: 'n1', model: 'deepseek-chat', promptVersion: 'v1', sourceSessionId: 'session-1',
      instruction: 'write', limit: 1, idempotencyKey: 'idem-2',
    })).rejects.toThrow('provider secret must not be persisted')
    expect(statuses).toEqual(['running:', 'failed:GENERATION_FAILED'])
  })

  it('rejects a completed run without a persisted result', async () => {
    const transitions: string[] = []
    let generated = 0
    const workflow = new NovelGenerationWorkflowService({
      authoring: {
        async createGenerationRun() { return 'run-completed' },
        async getGenerationRunStatus() { return 'completed' },
        async updateGenerationRunStatus(input) { transitions.push(input.status) },
      },
      generation: {
        async findPersistedResult() { return undefined },
        async generate() {
          generated += 1
          return { generationRunId: 'run-completed', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'idem-completed', selectedContext: [], records: [], proposals: [] }
        },
      },
      materialization: { async materialize() { return { records: [] } } },
    })

    await expect(workflow.generate({
      workspaceId: 'w1', novelId: 'n1', model: 'deepseek-chat', promptVersion: 'v1', sourceSessionId: 'session-1',
      instruction: 'retry', limit: 1, idempotencyKey: 'idem-completed',
    })).rejects.toThrow('completed generation result was not found')
    expect(transitions).toEqual([])
    expect(generated).toBe(0)
  })

  it('returns a persisted completed result without invoking generation again', async () => {
    const persisted: DraftGenerationResult = {
      generationRunId: 'run-persisted',
      workspaceId: 'w1',
      novelId: 'n1',
      idempotencyKey: 'idem-persisted',
      selectedContext: [],
      records: [{ targetType: 'characters', name: 'Lin', status: 'draft' }],
      proposals: [],
    }
    const transitions: string[] = []
    const findPersistedResult = vi.fn(async () => persisted)
    const generate = vi.fn(async () => {
      throw new Error('model provider must not be called for a completed run')
    })
    const generation = { generate, findPersistedResult }
    const workflow = new NovelGenerationWorkflowService({
      authoring: {
        async createGenerationRun() { return 'run-persisted' },
        async getGenerationRunStatus() { return 'completed' },
        async updateGenerationRunStatus(input) { transitions.push(input.status) },
      },
      generation,
      materialization: {
        async materialize(result) {
          expect(result).toBe(persisted)
          return { records: [] }
        },
      },
    })

    const result = await workflow.generate({
      workspaceId: 'w1',
      novelId: 'n1',
      model: 'deepseek-chat',
      promptVersion: 'v1',
      sourceSessionId: 'session-1',
      instruction: 'retry',
      limit: 1,
      idempotencyKey: 'idem-persisted',
    })

    expect(result.generation).toBe(persisted)
    expect(findPersistedResult).toHaveBeenCalledWith({
      workspaceId: 'w1',
      novelId: 'n1',
      idempotencyKey: 'idem-persisted',
    })
    expect(generate).not.toHaveBeenCalled()
    expect(transitions).toEqual([])
  })
})
