import { describe, expect, it, vi } from 'vitest'
import {
  GenerationMaterializationService, LongformAuthoringService,
  type DraftGenerationResult, type DraftProposalInput, type DraftRecordWriter,
} from '../src/index.ts'
import { serviceDatabase, worker } from './coverage-fixture.ts'

function generation(record: Record<string, unknown>): DraftGenerationResult {
  return {
    generationRunId: 'run', workspaceId: worker.workspaceId, novelId: 'novel', idempotencyKey: 'chapter-storage',
    selectedContext: [], records: [record], proposals: [],
  }
}

function chapterWriter(longform: LongformAuthoringService, createDraftProposal: DraftRecordWriter['createDraftProposal']) {
  const unused = async (): Promise<string> => { throw new Error('Unexpected non-chapter draft write') }
  return {
    createDraftProposal,
    createChapterVersionDraft: input => longform.createChapterVersionDraft(input),
    createCharacterDraft: unused, createSkillDraft: unused, createLocationDraft: unused,
    createFactionDraft: unused, createItemDraft: unused, createStorylineDraft: unused, createOutlineDraft: unused,
    createEntityRelationDraft: unused, createCharacterSkillDraft: unused, createStoryFactDraft: unused,
    createTimelineEventDraft: unused, createChapterDraft: unused, createChapterSummaryDraft: unused,
  } satisfies DraftRecordWriter
}

const cases = [
  { kind: 'postgres_text', fields: { contentStorageKind: 'postgres_text', contentText: 'hello', contentBytes: 5 }, absent: 'contentObjectKey', proposalField: 'content_object_key' },
  { kind: 'object_storage', fields: { content_storage_kind: 'object_storage', content_object_key: 'chapters/body', content_bytes: 1024 * 1024 + 1 }, absent: 'contentText', proposalField: 'content_text' },
] as const

describe('generated chapter storage with the real draft writer', () => {
  it.each(cases)('persists $kind metadata while omitting the unused storage field', async (entry) => {
    const database = serviceDatabase()
    const storage = { assertAvailable: vi.fn(async () => undefined) }
    const longform = new LongformAuthoringService(database.database, worker, storage)
    const createVersion = vi.spyOn(longform, 'createChapterVersionDraft')
    const createProposal = vi.fn(async (_input: DraftProposalInput) => 'proposal')
    const writer = chapterWriter(longform, createProposal)
    const result = await new GenerationMaterializationService(writer).materialize(generation({
      targetType: 'chapter_versions', chapterId: 'chapter', versionNo: 1, contentSha256: 'a'.repeat(64), ...entry.fields,
    }))
    expect(result.records).toEqual([{ targetType: 'chapter_versions', targetId: 'created', proposalId: 'proposal' }])
    expect(createVersion.mock.calls[0]?.[0]).not.toHaveProperty(entry.absent)
    expect(createVersion.mock.calls[0]?.[0]).toHaveProperty('summary', null)
    expect(database.writes[0]?.values).toMatchObject({ status: 'draft', contentStorageKind: entry.kind })
    expect(createProposal.mock.calls[0]?.[0].proposedContent[entry.proposalField]).toBeNull()
    expect(storage.assertAvailable).toHaveBeenCalledTimes(entry.kind === 'object_storage' ? 1 : 0)
  })

  it('keeps rejecting both storage fields before a database write', async () => {
    const database = serviceDatabase()
    const longform = new LongformAuthoringService(database.database, worker)
    const writer = chapterWriter(longform, vi.fn(async () => 'proposal'))
    await expect(new GenerationMaterializationService(writer).materialize(generation({
      targetType: 'chapter_versions', chapterId: 'chapter', versionNo: 1, contentSha256: 'a'.repeat(64),
      contentStorageKind: 'postgres_text', contentText: 'hello', contentBytes: 5, contentObjectKey: 'chapters/body',
    }))).rejects.toThrow('PostgreSQL text storage requires content text and no object key')
    expect(database.writes).toEqual([])
    expect(writer.createDraftProposal).not.toHaveBeenCalled()
  })
})
