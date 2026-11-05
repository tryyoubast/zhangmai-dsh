import { describe, expect, it, vi } from 'vitest'
import { GenerationMaterializationService, type DraftGenerationResult, type DraftRecordWriter, type NovelDraftTargetType } from '../src/index.ts'

const cases = [
  { type: 'outlines', method: 'createOutlineDraft', record: { name: 'Arc' } },
  { type: 'characters', method: 'createCharacterDraft', record: { name: 'Lin' } },
  { type: 'skills', method: 'createSkillDraft', record: { name: 'Blink' } },
  { type: 'locations', method: 'createLocationDraft', record: { name: 'Gate' } },
  { type: 'factions', method: 'createFactionDraft', record: { name: 'Guard' } },
  { type: 'items', method: 'createItemDraft', record: { name: 'Key' } },
  { type: 'storylines', method: 'createStorylineDraft', record: { name: 'Arrival' } },
  { type: 'entity_relations', method: 'createEntityRelationDraft', record: { sourceEntityType: 'characters', sourceEntityId: 'c1', targetEntityType: 'locations', targetEntityId: 'l1', relationType: 'guards' } },
  { type: 'character_skills', method: 'createCharacterSkillDraft', record: { characterId: 'c1', skillId: 's1', relationType: 'knows' } },
  { type: 'chapters', method: 'createChapterDraft', record: { chapterNo: 1, title: 'Arrival' } },
  { type: 'chapter_versions', method: 'createChapterVersionDraft', record: { chapterId: 'ch1', versionNo: 1, contentSha256: 'a'.repeat(64), contentBytes: 5, contentStorageKind: 'postgres_text', contentText: 'hello' } },
  { type: 'chapter_summaries', method: 'createChapterSummaryDraft', record: { chapterId: 'ch1', chapterVersionId: 'v1', summaryKind: 'short', contentText: 'Arrival', contentSha256: 'b'.repeat(64) } },
  { type: 'story_facts', method: 'createStoryFactDraft', record: { factKey: 'gate.open', statement: 'The gate is open' } },
  { type: 'timeline_events', method: 'createTimelineEventDraft', record: { eventKey: 'arrival', title: 'Arrival' } },
] as const satisfies readonly { type: NovelDraftTargetType; method: keyof DraftRecordWriter; record: Record<string, unknown> }[]

function recordingWriter() {
  const draft = () => vi.fn(async (_input: unknown) => 'target-1')
  return {
    createDraftProposal: vi.fn(async (_input: unknown) => 'proposal-1'),
    createCharacterDraft: draft(), createSkillDraft: draft(), createLocationDraft: draft(),
    createFactionDraft: draft(), createItemDraft: draft(), createStorylineDraft: draft(), createOutlineDraft: draft(),
    createEntityRelationDraft: draft(), createCharacterSkillDraft: draft(), createStoryFactDraft: draft(),
    createTimelineEventDraft: draft(), createChapterDraft: draft(), createChapterVersionDraft: draft(), createChapterSummaryDraft: draft(),
  } satisfies DraftRecordWriter
}

function generation(records: DraftGenerationResult['records'], proposals: DraftGenerationResult['proposals'] = []): DraftGenerationResult {
  return { generationRunId: 'run-1', workspaceId: 'w1', novelId: 'n1', idempotencyKey: 'generation-1', selectedContext: [], records, proposals }
}

describe('generation materialization validation', () => {
  it.each(cases)('dispatches $type to its fixed writer and creates its review proposal', async ({ type, method, record }) => {
    const writer = recordingWriter()
    await expect(new GenerationMaterializationService(writer).materialize(generation([{ targetType: type, ...record }]))).resolves.toEqual({
      records: [{ targetType: type, targetId: 'target-1', proposalId: 'proposal-1' }],
    })
    expect(writer[method]).toHaveBeenCalledTimes(1)
    expect(writer.createDraftProposal).toHaveBeenCalledWith(expect.objectContaining({ targetType: type, targetId: 'target-1' }))
    expect(Object.values(writer).reduce((count, write) => count + write.mock.calls.length, 0)).toBe(2)
  })

  it.each([undefined, null, '', 'unsupported', 'constructor', 'toString', '__proto__', 42, {}])('rejects target %j before any record or proposal writer', async (targetType) => {
    for (const array of ['records', 'proposals'] as const) {
      const writer = recordingWriter()
      const record = { targetType, targetId: 'target-1', name: 'Lin' }
      const result = array === 'records' ? generation([record]) : generation([], [record])
      await expect(new GenerationMaterializationService(writer).materialize(result)).rejects.toThrow()
      for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
    }
  })

  it.each(['publish', '', 42, true, {}])('rejects operation %j before any writer', async (operation) => {
    for (const array of ['records', 'proposals'] as const) {
      const writer = recordingWriter()
      const record = { targetType: 'characters', targetId: 'target-1', name: 'Lin', operation }
      const result = array === 'records' ? generation([record]) : generation([], [record])
      await expect(new GenerationMaterializationService(writer).materialize(result)).rejects.toThrow('operation is invalid')
      for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
    }
  })

  it.each([{ attributes: { sql: 'select 1' } }, { attributes: { DDL: 'create table x' } }, { status: 'published' }, { attributes: [{ status: 'deleted' }] }])('rejects unsafe provider data %j before any writer', async (fields) => {
    const writer = recordingWriter()
    await expect(new GenerationMaterializationService(writer).materialize(generation([{ targetType: 'characters', name: 'Lin', ...fields }]))).rejects.toThrow()
    for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
  })

  it.each([null, [], 42, 'character'])('rejects non-object provider records %j before any writer', async (record) => {
    const writer = recordingWriter()
    const serialized = JSON.stringify({ ...generation([]), records: [record] })
    const decoded = JSON.parse(serialized) as DraftGenerationResult
    await expect(new GenerationMaterializationService(writer).materialize(decoded)).rejects.toThrow('must contain objects')
    for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
  })

  it('keeps null relation metadata and empty attributes in exact writer and proposal payloads', async () => {
    const writer = recordingWriter()
    await new GenerationMaterializationService(writer).materialize(generation([
      { targetType: 'entity_relations', sourceEntityType: 'characters', sourceEntityId: 'c1', targetEntityType: 'locations', targetEntityId: 'l1', relationType: 'guards' },
      { targetType: 'character_skills', characterId: 'c1', skillId: 's1', relationType: 'knows' },
    ]))
    const base = { generationRunId: 'run-1', workspaceId: 'w1', novelId: 'n1' }
    expect(writer.createEntityRelationDraft).toHaveBeenCalledWith({ ...base, idempotencyKey: 'generation-1:0', sourceEntityType: 'characters', sourceEntityId: 'c1', targetEntityType: 'locations', targetEntityId: 'l1', relationType: 'guards', strength: null, sourceVersionNo: null, attributes: {} })
    expect(writer.createCharacterSkillDraft).toHaveBeenCalledWith({ ...base, idempotencyKey: 'generation-1:1', characterId: 'c1', skillId: 's1', relationType: 'knows', sourceVersionNo: null, attributes: {} })
    expect(writer.createDraftProposal.mock.calls.map(([input]) => input)).toEqual([
      { ...base, targetType: 'entity_relations', targetId: 'target-1', operation: 'create', proposedContent: { source_entity_type: 'characters', source_entity_id: 'c1', target_entity_type: 'locations', target_entity_id: 'l1', relation_type: 'guards', strength: null, source_version_no: null, valid_from: null, valid_to: null, attributes_jsonb: {}, attributes_schema_version: 1 }, validationResult: { valid: true, schemaVersion: 1, source: 'structured_generation' }, idempotencyKey: 'generation-1:0:proposal' },
      { ...base, targetType: 'character_skills', targetId: 'target-1', operation: 'link', proposedContent: { character_id: 'c1', skill_id: 's1', relation_type: 'knows', source_version_no: null, attributes_jsonb: {}, attributes_schema_version: 1 }, validationResult: { valid: true, schemaVersion: 1, source: 'structured_generation' }, idempotencyKey: 'generation-1:1:proposal' },
    ])
  })
})
