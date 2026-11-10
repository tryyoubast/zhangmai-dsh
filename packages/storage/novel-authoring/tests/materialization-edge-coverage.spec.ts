import { describe, expect, it, vi } from 'vitest'
import { GenerationMaterializationService, type DraftGenerationResult, type DraftRecordWriter, type DraftProposalInput, type MaterializationResult } from '../src/index.ts'

function recordingWriter() {
  const draft = () => vi.fn(async (_input: unknown) => 'target')
  return {
    createDraftProposal: vi.fn(async (_input: DraftProposalInput) => 'proposal'),
    createCharacterDraft: draft(), createSkillDraft: draft(), createLocationDraft: draft(),
    createFactionDraft: draft(), createItemDraft: draft(), createStorylineDraft: draft(), createOutlineDraft: draft(),
    createEntityRelationDraft: draft(), createCharacterSkillDraft: draft(), createStoryFactDraft: draft(),
    createTimelineEventDraft: draft(), createChapterDraft: draft(), createChapterVersionDraft: draft(), createChapterSummaryDraft: draft(),
  } satisfies DraftRecordWriter
}

function result(records: DraftGenerationResult['records'] = [], proposals: DraftGenerationResult['proposals'] = []): DraftGenerationResult {
  return { generationRunId: 'materialize-run', workspaceId: 'workspace', novelId: 'novel', idempotencyKey: 'materialize-key', selectedContext: [], records, proposals }
}

const validCases: readonly { type: string; fields: Record<string, unknown>; required: readonly string[] }[] = [
  { type: 'characters', fields: { name: 'Lin' }, required: ['name'] },
  { type: 'skills', fields: { name: 'Blink' }, required: ['name'] },
  { type: 'locations', fields: { name: 'Gate' }, required: ['name'] },
  { type: 'factions', fields: { name: 'Guard' }, required: ['name'] },
  { type: 'items', fields: { name: 'Key' }, required: ['name'] },
  { type: 'storylines', fields: { name: 'Arrival' }, required: ['name'] },
  { type: 'outlines', fields: { name: 'Arc' }, required: ['name'] },
  { type: 'entity_relations', fields: { sourceEntityType: 'characters', sourceEntityId: 'hero', targetEntityType: 'locations', targetEntityId: 'gate', relationType: 'guards' }, required: ['sourceEntityType', 'sourceEntityId', 'targetEntityType', 'targetEntityId', 'relationType'] },
  { type: 'character_skills', fields: { characterId: 'hero', skillId: 'blink', relationType: 'knows' }, required: ['characterId', 'skillId', 'relationType'] },
  { type: 'chapters', fields: { chapterNo: 1, title: 'Arrival' }, required: ['chapterNo', 'title'] },
  { type: 'chapter_versions', fields: { chapterId: 'chapter', versionNo: 1, contentSha256: 'hash', contentBytes: 5, contentStorageKind: 'postgres_text', contentText: 'hello' }, required: ['chapterId', 'versionNo', 'contentSha256', 'contentBytes', 'contentStorageKind'] },
  { type: 'chapter_summaries', fields: { chapterId: 'chapter', chapterVersionId: 'version', summaryKind: 'short', contentText: 'Arrival', contentSha256: 'hash' }, required: ['chapterId', 'chapterVersionId', 'summaryKind', 'contentText', 'contentSha256'] },
  { type: 'story_facts', fields: { factKey: 'gate.open', statement: 'Gate opens' }, required: ['factKey', 'statement'] },
  { type: 'timeline_events', fields: { eventKey: 'arrival', title: 'Arrival' }, required: ['eventKey', 'title'] },
]

describe('materialization untrusted fields and proposal payloads', () => {
  for (const entry of validCases) {
    it(`accepts a ${entry.type} update proposal without creating a duplicate target`, async () => {
      const writer = recordingWriter()
      const materialized = await new GenerationMaterializationService(writer).materialize(result([], [{
        type: entry.type, target_id: 'existing-target', ...entry.fields,
      }]))
      expect(materialized.records).toEqual([{ targetType: entry.type, targetId: 'existing-target', proposalId: 'proposal' }])
      expect(writer.createDraftProposal).toHaveBeenCalledOnce()
      expect(writer.createDraftProposal.mock.calls[0]?.[0]).toMatchObject({
        operation: 'update', idempotencyKey: 'materialize-key:0:proposal', targetId: 'existing-target',
      })
      for (const [name, write] of Object.entries(writer)) if (name !== 'createDraftProposal') expect(write).not.toHaveBeenCalled()
    })
    for (const field of entry.required) {
      it(`rejects ${entry.type} missing ${field} before either record or proposal writes`, async () => {
        const fields = Object.fromEntries(Object.entries(entry.fields).filter(([name]) => name !== field))
        for (const proposal of [false, true]) {
          const writer = recordingWriter()
          const record = { targetType: entry.type, targetId: 'existing', ...fields }
          await expect(new GenerationMaterializationService(writer).materialize(proposal ? result([], [record]) : result([record])))
            .rejects.toThrow(/required|integer/)
          for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
        }
      })
    }
  }

  it.each([null, [], 1, true])('rejects non-object attributes %j before writing', async (attributes) => {
    const writer = recordingWriter()
    await expect(new GenerationMaterializationService(writer).materialize(result([{ type: 'characters', name: 'Lin', attributes }])))
      .rejects.toThrow('attributes must be an object')
    for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
  })

  it.each([null, [], false, 1])('rejects malformed proposal %j without writing', async (invalid) => {
    const writer = recordingWriter()
    const decoded = JSON.parse(JSON.stringify({ ...result(), proposals: [invalid] })) as DraftGenerationResult
    await expect(new GenerationMaterializationService(writer).materialize(decoded)).rejects.toThrow('generated proposals must contain objects')
    expect(writer.createDraftProposal).not.toHaveBeenCalled()
  })

  it.each([undefined, null, '', 1])('rejects an update without a usable target ID %j', async (targetId) => {
    const writer = recordingWriter()
    await expect(new GenerationMaterializationService(writer).materialize(result([], [{ targetType: 'characters', name: 'Lin', targetId }])))
      .rejects.toThrow('targetId is required')
    expect(writer.createDraftProposal).not.toHaveBeenCalled()
  })

  it.each([null, '', '1', 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects malformed proposal base version %j', async (baseVersionNo) => {
    const writer = recordingWriter()
    await expect(new GenerationMaterializationService(writer).materialize(result([], [{ targetType: 'characters', name: 'Lin', targetId: 'hero', baseVersionNo }])))
      .rejects.toThrow('baseVersionNo must be an integer')
    expect(writer.createDraftProposal).not.toHaveBeenCalled()
  })

  it('preserves optional proposal version and link operation without inventing missing values', async () => {
    const writer = recordingWriter()
    await new GenerationMaterializationService(writer).materialize(result([], [
      { type: 'characters', targetId: 'hero', name: 'Lin' },
      { type: 'character_skills', targetId: 'link', characterId: 'hero', skillId: 'blink', relationType: 'knows', operation: 'link', baseVersionNo: 3 },
    ]))
    expect(writer.createDraftProposal.mock.calls[0]?.[0]).not.toHaveProperty('baseVersionNo')
    expect(writer.createDraftProposal.mock.calls[1]?.[0]).toMatchObject({ operation: 'link', baseVersionNo: 3, idempotencyKey: 'materialize-key:1:proposal' })
  })

  it('resolves snake-case references to earlier records while preferring explicit target IDs', async () => {
    const writer = recordingWriter()
    await new GenerationMaterializationService(writer).materialize(result([
      { type: 'characters', name: 'Lin', clientKey: 'hero' },
      { type: 'skills', name: 'Blink', clientKey: 'blink' },
      { type: 'character_skills', character_ref: 'hero', skill_ref: 'blink', relation_type: 'knows', source_version_no: 2 },
      { type: 'entity_relations', source_entity_type: 'characters', source_entity_ref: 'hero', target_entity_type: 'skills', target_entity_id: 'explicit-skill', relation_type: 'uses', source_version_no: 2, strength: 7 },
    ]))
    expect(writer.createCharacterSkillDraft).toHaveBeenCalledWith(expect.objectContaining({ characterId: 'target', skillId: 'target', sourceVersionNo: 2 }))
    expect(writer.createEntityRelationDraft).toHaveBeenCalledWith(expect.objectContaining({ sourceEntityId: 'target', targetEntityId: 'explicit-skill', strength: 7 }))
  })

  it.each(['missing', ''])('rejects an unresolved forward reference %j', async (characterRef) => {
    const writer = recordingWriter()
    await expect(new GenerationMaterializationService(writer).materialize(result([{ type: 'character_skills', characterRef, skillId: 'skill', relationType: 'knows' }])))
      .rejects.toThrow('generated characterId is required')
    expect(writer.createCharacterSkillDraft).not.toHaveBeenCalled()
  })

  it('preserves object-storage and detailed/facts summaries with snake-case fields', async () => {
    const writer = recordingWriter()
    await new GenerationMaterializationService(writer).materialize(result([
      { type: 'chapters', chapter_no: 2, title: 'Arrival', clientKey: 'chapter' },
      { type: 'chapter_versions', chapter_ref: 'chapter', version_no: 2, content_sha256: 'hash', content_bytes: 12, content_storage_kind: 'object_storage', content_object_key: 'chapter/object', clientKey: 'version' },
      ...['detailed', 'facts'].map(summaryKind => ({ type: 'chapter_summaries', chapter_ref: 'chapter', chapter_version_ref: 'version', summary_kind: summaryKind, content_text: 'Arrival', content_sha256: 'hash' })),
    ]))
    expect(writer.createChapterVersionDraft).toHaveBeenCalledWith(expect.objectContaining({ chapterId: 'target', contentObjectKey: 'chapter/object', contentText: null }))
    expect(writer.createChapterSummaryDraft.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ chapterId: 'target', chapterVersionId: 'target', summaryKind: 'detailed' }),
      expect.objectContaining({ chapterId: 'target', chapterVersionId: 'target', summaryKind: 'facts' }),
    ])
  })

  it.each(['chapter_versions', 'chapter_summaries'])('rejects unsupported %s storage or summary classification before writing', async (targetType) => {
    const writer = recordingWriter()
    const record = targetType === 'chapter_versions'
      ? { targetType, contentStorageKind: 'filesystem' }
      : { targetType, summaryKind: 'complete' }
    await expect(new GenerationMaterializationService(writer).materialize(result([record]))).rejects.toThrow('is invalid for generated')
    for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
  })

  it('rejects whitespace names and non-integral chapter numbers before writing', async () => {
    for (const record of [{ type: 'characters', name: '   ' }, { type: 'chapters', chapterNo: 2.5, title: 'Arrival' }]) {
      const writer = recordingWriter()
      await expect(new GenerationMaterializationService(writer).materialize(result([record]))).rejects.toThrow(/required|integer/)
      for (const write of Object.values(writer)) expect(write).not.toHaveBeenCalled()
    }
  })
})

describe('materialization settlement and retry ownership', () => {
  it('keeps the outer pending task when a reentrant writer attempt fails', async () => {
    const writer = recordingWriter()
    const service = new GenerationMaterializationService(writer)
    const input = result([{ type: 'characters', name: 'Lin' }])
    const outerWrite = Promise.withResolvers<string>()
    const failure = new Error('reentrant writer attempt failed')
    let nestedSettled: Promise<PromiseSettledResult<MaterializationResult>[]> | undefined
    writer.createCharacterDraft.mockImplementationOnce(() => {
      // An injected writer can reenter before the initiating task is registered.
      nestedSettled = Promise.allSettled([service.materialize(input)])
      return outerWrite.promise
    }).mockRejectedValueOnce(failure)
    const first = service.materialize(input)
    const firstSettled = Promise.allSettled([first])
    let follower: Promise<MaterializationResult> | undefined
    try {
      if (nestedSettled === undefined) throw new Error('writer did not reenter materialization')
      expect(await nestedSettled).toEqual([{ status: 'rejected', reason: failure }])
      follower = service.materialize(input)
      expect(writer.createCharacterDraft).toHaveBeenCalledTimes(2)
      outerWrite.resolve('hero')
      const [original, shared] = await Promise.all([first, follower])
      expect(shared).toBe(original)
      expect(shared.records).toEqual([{ targetType: 'characters', targetId: 'hero', proposalId: 'proposal' }])
      expect(writer.createDraftProposal).toHaveBeenCalledOnce()
    } finally {
      outerWrite.resolve('hero')
      await firstSettled
      if (follower !== undefined) await Promise.allSettled([follower])
      if (nestedSettled !== undefined) await nestedSettled
    }
  })

  it('shares overlapping work without duplicating record or proposal writes', async () => {
    const writer = recordingWriter()
    let release: (id: string) => void = () => { throw new Error('record writer was not started') }
    writer.createCharacterDraft.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
    const service = new GenerationMaterializationService(writer)
    const input = result([{ type: 'characters', name: 'Lin' }])
    const first = service.materialize(input)
    const second = service.materialize(input)
    expect(writer.createCharacterDraft).toHaveBeenCalledOnce()
    release('hero')
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(writer.createDraftProposal).toHaveBeenCalledOnce()
  })

  it('clears failed in-flight work and retries with the same deterministic writer keys', async () => {
    const writer = recordingWriter()
    const failure = new Error('proposal store unavailable')
    writer.createDraftProposal.mockRejectedValueOnce(failure)
    const service = new GenerationMaterializationService(writer)
    const input = result([{ type: 'characters', name: 'Lin' }])
    await expect(service.materialize(input)).rejects.toBe(failure)
    await expect(service.materialize(input)).resolves.toEqual({ records: [{ targetType: 'characters', targetId: 'target', proposalId: 'proposal' }] })
    expect(writer.createCharacterDraft.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ idempotencyKey: 'materialize-key:0' }), expect.objectContaining({ idempotencyKey: 'materialize-key:0' }),
    ])
  })
})
