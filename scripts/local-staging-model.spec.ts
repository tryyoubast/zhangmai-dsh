import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeepSeekNovelGenerationAdapter, GenerationMaterializationService, type DraftRecordWriter } from '@deepseek-ai/dsh-novel-authoring'
import { REAL_CONTINUATION_INSTRUCTION } from '../deploy/local-test/real-resume.ts'

let child: ChildProcess
let baseUrl: string

beforeAll(async () => {
  child = fork(resolve(import.meta.dirname, '../deploy/local-test/model.mjs'), [], {
    env: { ...process.env, DSH_FIXTURE_HOST: '127.0.0.1', DSH_FIXTURE_PORT: '0' },
    silent: true,
    execArgv: [],
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, 3_000)
  try {
    const [message] = await once(child, 'message', { signal: controller.signal }) as unknown[]
    if (typeof message !== 'object' || message === null || !('port' in message) || typeof message.port !== 'number') {
      throw new Error('fixture did not report its bound port')
    }
    baseUrl = `http://127.0.0.1:${String(message.port)}`
  } finally {
    clearTimeout(timeout)
  }
})

afterAll(async () => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
})

const input = (instruction: string) => ({
  workspaceId: 'workspace', novelId: 'novel', generationRunId: 'run', idempotencyKey: instruction, instruction, context: [],
})

function adapter() {
  return new DeepSeekNovelGenerationAdapter({ apiKey: 'fixture-only', baseUrl: `${baseUrl}/v1` })
}

describe('local staging fixed model responses', () => {
  it('uses the full real continuation instruction to return three bounded draft types and chapter 2', async () => {
    const generated = await adapter().generate(input(REAL_CONTINUATION_INSTRUCTION))
    expect(generated.records).toHaveLength(3)
    expect(generated.records).toEqual([
      expect.objectContaining({ targetType: 'characters', name: 'Lantern Courier' }),
      expect.objectContaining({ targetType: 'locations', name: 'Lantern Pier' }),
      expect.objectContaining({ targetType: 'chapters', chapterNo: 2 }),
    ])
  })
  it('materializes all fourteen supported types through the real output validator', async () => {
    const draft = async () => 'draft-id'
    const writer: DraftRecordWriter = {
      createDraftProposal: draft, createCharacterDraft: draft, createSkillDraft: draft, createLocationDraft: draft,
      createFactionDraft: draft, createItemDraft: draft, createStorylineDraft: draft, createOutlineDraft: draft,
      createEntityRelationDraft: draft, createCharacterSkillDraft: draft, createStoryFactDraft: draft,
      createTimelineEventDraft: draft, createChapterDraft: draft, createChapterVersionDraft: draft, createChapterSummaryDraft: draft,
    }
    const generated = await adapter().generate(input('fixture:all'))
    const result = await new GenerationMaterializationService(writer).materialize({
      ...input('fixture:all'), selectedContext: [], records: generated.records ?? [], proposals: generated.proposals ?? [],
    })
    expect(new Set(result.records.map(record => record.targetType)).size).toBe(14)
  })

  it('returns a bounded update proposal for the publication and conflict scenarios', async () => {
    const proposal = { targetType: 'characters', targetId: 'character-id', operation: 'update', baseVersionNo: 1, name: 'Lin II' }
    const generated = await adapter().generate(input(`fixture:proposal ${JSON.stringify(proposal)}`))
    expect(generated).toEqual({ records: [], proposals: [proposal] })
    const written: unknown[] = []
    const draft = async () => 'draft-id'
    const writer: DraftRecordWriter = {
      createDraftProposal: async (value) => { written.push(value); return 'proposal-id' },
      createCharacterDraft: draft, createSkillDraft: draft, createLocationDraft: draft,
      createFactionDraft: draft, createItemDraft: draft, createStorylineDraft: draft, createOutlineDraft: draft,
      createEntityRelationDraft: draft, createCharacterSkillDraft: draft, createStoryFactDraft: draft,
      createTimelineEventDraft: draft, createChapterDraft: draft, createChapterVersionDraft: draft, createChapterSummaryDraft: draft,
    }
    await new GenerationMaterializationService(writer).materialize({
      ...input('fixture:update'), selectedContext: [], records: generated.records ?? [], proposals: generated.proposals ?? [],
    })
    expect(written).toEqual([expect.objectContaining({
      targetType: 'characters', targetId: 'character-id', operation: 'update', baseVersionNo: 1,
      proposedContent: { name: 'Lin II', summary: null, attributes_jsonb: {}, attributes_schema_version: 1 },
    })])
  })

  it('accepts persisted story keywords as the continuation instruction', async () => {
    const generated = await adapter().generate(input('Moon Harbor'))
    expect(generated).toEqual({
      records: [{ targetType: 'characters', name: 'Continuation courier', summary: 'Restored 0 context items' }],
      proposals: [],
    })
  })

  it('records provider calls by idempotency key without exposing credentials or the prompt', async () => {
    const response = await fetch(`${baseUrl}/stats`)
    const stats: unknown = await response.json()
    expect(stats).toMatchObject({ calls: { 'fixture:all': 1 }, pending: 0 })
    expect(JSON.stringify(stats)).not.toContain('fixture-only')
  })

  it('makes malformed fixture records fail through the real adapter', async () => {
    await expect(adapter().generate(input('fixture:invalid'))).rejects.toThrow('array of objects')
  })
})
