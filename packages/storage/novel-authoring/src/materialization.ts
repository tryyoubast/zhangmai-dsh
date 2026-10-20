import type {
  CharacterDraftInput,
  CharacterSkillDraftInput,
  ChapterDraftInput,
  ChapterVersionDraftInput,
  ChapterSummaryDraftInput,
  DraftGenerationResult,
  DraftProposalInput,
  EntityRelationDraftInput,
  NamedEntityDraftInput,
  NovelDraftTargetType,
  StoryFactDraftInput,
  TimelineEventDraftInput,
} from './index.ts'

/** Minimum domain writer surface used to materialize validated model output. */
export interface DraftRecordWriter {
  createDraftProposal(input: DraftProposalInput): Promise<string>
  createCharacterDraft(input: CharacterDraftInput): Promise<string>
  createSkillDraft(input: NamedEntityDraftInput): Promise<string>
  createLocationDraft(input: NamedEntityDraftInput): Promise<string>
  createFactionDraft(input: NamedEntityDraftInput): Promise<string>
  createItemDraft(input: NamedEntityDraftInput): Promise<string>
  createStorylineDraft(input: NamedEntityDraftInput): Promise<string>
  createOutlineDraft(input: NamedEntityDraftInput): Promise<string>
  createEntityRelationDraft(input: EntityRelationDraftInput): Promise<string>
  createCharacterSkillDraft(input: CharacterSkillDraftInput): Promise<string>
  createStoryFactDraft(input: StoryFactDraftInput): Promise<string>
  createTimelineEventDraft(input: TimelineEventDraftInput): Promise<string>
  createChapterDraft(input: ChapterDraftInput): Promise<string>
  createChapterVersionDraft(input: ChapterVersionDraftInput): Promise<string>
  createChapterSummaryDraft(input: ChapterSummaryDraftInput): Promise<string>
}

interface GeneratedRecord extends Record<string, unknown> {
  targetType?: NovelDraftTargetType
  type?: NovelDraftTargetType
  operation?: 'create' | 'update' | 'link'
  clientKey?: string
}

export interface MaterializedDraftRecord {
  readonly targetType: NovelDraftTargetType
  readonly targetId: string
  readonly proposalId: string
}

export interface MaterializationResult {
  readonly records: readonly MaterializedDraftRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(record: Record<string, unknown>, name: string): string
function text(record: Record<string, unknown>, name: string, required: false): string | undefined
function text(record: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = record[name]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (!required && value === undefined) return undefined
  throw new Error(`${name} is required for generated ${String(record.targetType ?? record.type)}`)
}

function integer(record: Record<string, unknown>, name: string): number
function integer(record: Record<string, unknown>, name: string, required: false): number | undefined
function integer(record: Record<string, unknown>, name: string, required = true): number | undefined {
  const value = record[name]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (!required && value === undefined) return undefined
  throw new Error(`${name} must be an integer for generated ${String(record.targetType ?? record.type)}`)
}

function alias(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name]
  }
  return undefined
}

function aliasText(record: Record<string, unknown>, ...names: string[]): string | null {
  const value = alias(record, ...names)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function aliasInteger(record: Record<string, unknown>, ...names: string[]): number | null {
  const value = alias(record, ...names)
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function aliasObject(record: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  const value = alias(record, ...names)
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${names[0]} must be an object for generated ${String(record.targetType ?? record.type)}`)
  return value
}

function resolvedId(
  record: GeneratedRecord,
  idNames: readonly string[],
  refNames: readonly string[],
  references: Map<string, string>,
): string {
  for (const name of idNames) {
    const value = aliasText(record, name)
    if (value !== null) return value
  }
  for (const name of refNames) {
    const reference = aliasText(record, name)
    if (reference !== null) {
      const resolved = references.get(reference)
      if (resolved !== undefined) return resolved
    }
  }
  throw new Error(`generated ${idNames[0]} is required`)
}

/** Match the exact non-metadata JSON payload used by the publication guards. */
function canonicalProposalContent(
  type: NovelDraftTargetType,
  record: GeneratedRecord,
  references: Map<string, string>,
): Record<string, unknown> {
  const named = (): Record<string, unknown> => ({
    name: aliasText(record, 'name') ?? text(record, 'name'),
    summary: aliasText(record, 'summary'),
    attributes_jsonb: aliasObject(record, 'attributes', 'attributes_jsonb'),
    attributes_schema_version: 1,
  })
  switch (type) {
    case 'characters': case 'skills': case 'locations': case 'factions': case 'items': case 'storylines':
      return named()
    case 'entity_relations':
      return {
        source_entity_type: aliasText(record, 'source_entity_type', 'sourceEntityType') ?? text(record, 'sourceEntityType'),
        source_entity_id: resolvedId(record, ['source_entity_id', 'sourceEntityId'], ['source_entity_ref', 'sourceEntityRef'], references),
        target_entity_type: aliasText(record, 'target_entity_type', 'targetEntityType') ?? text(record, 'targetEntityType'),
        target_entity_id: resolvedId(record, ['target_entity_id', 'targetEntityId'], ['target_entity_ref', 'targetEntityRef'], references),
        relation_type: aliasText(record, 'relation_type', 'relationType') ?? text(record, 'relationType'),
        source_version_no: aliasInteger(record, 'source_version_no', 'sourceVersionNo'),
        valid_from: null,
        valid_to: null,
        strength: aliasInteger(record, 'strength'),
        attributes_jsonb: aliasObject(record, 'attributes', 'attributes_jsonb'),
        attributes_schema_version: 1,
      }
    case 'character_skills':
      return {
        character_id: resolvedId(record, ['character_id', 'characterId'], ['character_ref', 'characterRef'], references),
        skill_id: resolvedId(record, ['skill_id', 'skillId'], ['skill_ref', 'skillRef'], references),
        relation_type: aliasText(record, 'relation_type', 'relationType') ?? text(record, 'relationType'),
        source_version_no: aliasInteger(record, 'source_version_no', 'sourceVersionNo'),
        attributes_jsonb: aliasObject(record, 'attributes', 'attributes_jsonb'),
        attributes_schema_version: 1,
      }
    case 'outlines':
      return { title: aliasText(record, 'title') ?? text(record, 'name'), content_jsonb: aliasObject(record, 'content_jsonb', 'contentJsonb', 'attributes') }
    case 'chapters':
      return { chapter_no: aliasInteger(record, 'chapter_no', 'chapterNo') ?? integer(record, 'chapterNo'), title: aliasText(record, 'title') ?? text(record, 'title'), summary: aliasText(record, 'summary') }
    case 'chapter_versions':
      return {
        chapter_id: resolvedId(record, ['chapter_id', 'chapterId'], ['chapter_ref', 'chapterRef'], references),
        version_no: aliasInteger(record, 'version_no', 'versionNo') ?? integer(record, 'versionNo'),
        content_sha256: aliasText(record, 'content_sha256', 'contentSha256') ?? text(record, 'contentSha256'),
        content_bytes: aliasInteger(record, 'content_bytes', 'contentBytes') ?? integer(record, 'contentBytes'),
        content_storage_kind: aliasText(record, 'content_storage_kind', 'contentStorageKind') ?? text(record, 'contentStorageKind'),
        content_text: aliasText(record, 'content_text', 'contentText'),
        content_object_key: aliasText(record, 'content_object_key', 'contentObjectKey'),
        summary: aliasText(record, 'summary'),
        source_type: 'ai_generation',
        source_id: null,
      }
    case 'chapter_summaries':
      return {
        chapter_id: resolvedId(record, ['chapter_id', 'chapterId'], ['chapter_ref', 'chapterRef'], references),
        chapter_version_id: resolvedId(record, ['chapter_version_id', 'chapterVersionId'], ['chapter_version_ref', 'chapterVersionRef'], references),
        summary_kind: aliasText(record, 'summary_kind', 'summaryKind') ?? text(record, 'summaryKind'),
        content_text: aliasText(record, 'content_text', 'contentText') ?? text(record, 'contentText'),
        content_sha256: aliasText(record, 'content_sha256', 'contentSha256') ?? text(record, 'contentSha256'),
      }
    case 'story_facts':
      return {
        fact_key: aliasText(record, 'fact_key', 'factKey') ?? text(record, 'factKey'),
        statement: aliasText(record, 'statement') ?? text(record, 'statement'),
        attributes_jsonb: aliasObject(record, 'attributes', 'attributes_jsonb'),
        attributes_schema_version: 1,
        source_chapter_id: aliasText(record, 'source_chapter_id', 'sourceChapterId'),
        source_chapter_version_id: aliasText(record, 'source_chapter_version_id', 'sourceChapterVersionId'),
      }
    case 'timeline_events':
      return {
        event_key: aliasText(record, 'event_key', 'eventKey') ?? text(record, 'eventKey'),
        title: aliasText(record, 'title') ?? text(record, 'title'),
        description: aliasText(record, 'description'),
        sequence_no: aliasInteger(record, 'sequence_no', 'sequenceNo'),
        attributes_jsonb: aliasObject(record, 'attributes', 'attributes_jsonb'),
        attributes_schema_version: 1,
        source_chapter_id: aliasText(record, 'source_chapter_id', 'sourceChapterId'),
        source_chapter_version_id: aliasText(record, 'source_chapter_version_id', 'sourceChapterVersionId'),
      }
    default: throw new Error(`unsupported generated target type: ${type}`)
  }
}

function rejectUnsafeTree(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeTree(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
    if (['sql', 'ddl', 'query', 'databasequery', 'migration', 'migrationfile', 'rawsql'].includes(normalized)) {
      throw new Error(`generated draft contains SQL or DDL (${path}.${key})`)
    }
    if (normalized === 'status' && item !== 'draft') throw new Error(`generated draft must remain draft-only (${path}.${key})`)
    rejectUnsafeTree(item, `${path}.${key}`)
  }
}

function targetType(record: GeneratedRecord): NovelDraftTargetType {
  const value = record.targetType ?? record.type
  if (typeof value !== 'string') throw new Error('generated record targetType is required')
  return value as NovelDraftTargetType
}

function operation(record: GeneratedRecord): 'create' | 'update' | 'link' {
  const value = record.operation ?? 'create'
  if (value !== 'create' && value !== 'update' && value !== 'link') throw new Error('generated record operation is invalid')
  return value
}

function idempotency(result: DraftGenerationResult, index: number, suffix = ''): string {
  return `${result.idempotencyKey}:${index}${suffix}`
}

/**
 * Maps provider output to fixed domain writers. It never executes model data as
 * SQL and always creates draft records before the separate review proposal.
 */
export class GenerationMaterializationService {
  private readonly completed = new Map<string, MaterializationResult>()
  private readonly inFlight = new Map<string, Promise<MaterializationResult>>()

  constructor(private readonly writer: DraftRecordWriter) {}

  /** Materialize all supported provider records and their review proposals.
   *
   * Repeated calls for one generation share the completed result or in-flight
   * work. Durable writers still enforce the same idempotency keys after a
   * process restart.
   */
  async materialize(result: DraftGenerationResult): Promise<MaterializationResult> {
    const key = this.key(result)
    const completed = this.completed.get(key)
    if (completed !== undefined) return completed
    const running = this.inFlight.get(key)
    if (running !== undefined) return running
    const task = this.materializeOnce(result)
    this.inFlight.set(key, task)
    try {
      const materialization = await task
      this.completed.set(key, materialization)
      return materialization
    } finally {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key)
    }
  }

  private async materializeOnce(result: DraftGenerationResult): Promise<MaterializationResult> {
    const references = new Map<string, string>()
    const materialized: MaterializedDraftRecord[] = []
    for (const [index, raw] of result.records.entries()) {
      if (!isRecord(raw)) throw new Error('generated records must contain objects')
      const record = raw as GeneratedRecord
      rejectUnsafeTree(record, `records[${index}]`)
      const type = targetType(record)
      const action = operation(record)
      if (action !== 'create' && action !== 'link') throw new Error('only create and link records are supported')
      const targetId = await this.createRecord(result, record, type, index, references)
      const proposalId = await this.writer.createDraftProposal({
        generationRunId: result.generationRunId,
        workspaceId: result.workspaceId,
        novelId: result.novelId,
        targetType: type,
        targetId,
        operation: type === 'character_skills' ? 'link' : 'create',
        proposedContent: canonicalProposalContent(type, record, references),
        validationResult: { valid: true, schemaVersion: 1, source: 'structured_generation' },
        idempotencyKey: idempotency(result, index, ':proposal'),
      })
      materialized.push({ targetType: type, targetId, proposalId })
    }
    for (const [index, raw] of result.proposals.entries()) {
      if (!isRecord(raw)) throw new Error('generated proposals must contain objects')
      const proposal = raw as GeneratedRecord
      rejectUnsafeTree(proposal, `proposals[${index}]`)
      const type = targetType(proposal)
      const targetId = aliasText(proposal, 'targetId', 'target_id') ?? text(proposal, 'targetId')
      const proposalId = await this.writer.createDraftProposal({
        generationRunId: result.generationRunId,
        workspaceId: result.workspaceId,
        novelId: result.novelId,
        targetType: type,
        targetId,
        operation: operation(proposal) === 'link' ? 'link' : 'update',
        ...Object.fromEntries(Object.entries({ baseVersionNo: integer(proposal, 'baseVersionNo', false) }).filter(([, value]) => value !== undefined)),
        proposedContent: canonicalProposalContent(type, proposal, references),
        validationResult: { valid: true, schemaVersion: 1, source: 'structured_generation' },
        idempotencyKey: idempotency(result, result.records.length + index, ':proposal'),
      })
      materialized.push({ targetType: type, targetId, proposalId })
    }
    return { records: materialized }
  }

  private key(result: DraftGenerationResult): string {
    return `${result.workspaceId}\u0000${result.novelId}\u0000${result.generationRunId}\u0000${result.idempotencyKey}`
  }

  private async createRecord(
    result: DraftGenerationResult,
    record: GeneratedRecord,
    type: NovelDraftTargetType,
    index: number,
    references: Map<string, string>,
  ): Promise<string> {
    const base = {
      generationRunId: result.generationRunId,
      workspaceId: result.workspaceId,
      novelId: result.novelId,
      idempotencyKey: idempotency(result, index),
    }
    const optional = (values: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    )
    const nameInput = (): NamedEntityDraftInput => ({
      ...base,
      name: aliasText(record, 'name') ?? text(record, 'name'),
      ...optional({ summary: aliasText(record, 'summary'), attributes: aliasObject(record, 'attributes', 'attributes_jsonb') }),
    })
    let targetId: string
    switch (type) {
      case 'characters': targetId = await this.writer.createCharacterDraft({ ...base, name: aliasText(record, 'name') ?? text(record, 'name'), ...optional({ summary: aliasText(record, 'summary'), attributes: aliasObject(record, 'attributes', 'attributes_jsonb') }) }); break
      case 'skills': targetId = await this.writer.createSkillDraft(nameInput()); break
      case 'locations': targetId = await this.writer.createLocationDraft(nameInput()); break
      case 'factions': targetId = await this.writer.createFactionDraft(nameInput()); break
      case 'items': targetId = await this.writer.createItemDraft(nameInput()); break
      case 'storylines': targetId = await this.writer.createStorylineDraft(nameInput()); break
      case 'outlines': targetId = await this.writer.createOutlineDraft({
        ...base,
        name: aliasText(record, 'title') ?? aliasText(record, 'name') ?? text(record, 'name'),
        attributes: aliasObject(record, 'content_jsonb', 'contentJsonb', 'attributes'),
      }); break
      case 'story_facts': targetId = await this.writer.createStoryFactDraft({
        ...base,
        factKey: aliasText(record, 'fact_key', 'factKey') ?? text(record, 'factKey'),
        statement: aliasText(record, 'statement') ?? text(record, 'statement'),
        ...optional({
          attributes: aliasObject(record, 'attributes', 'attributes_jsonb'),
          sourceChapterId: aliasText(record, 'source_chapter_id', 'sourceChapterId'),
          sourceChapterVersionId: aliasText(record, 'source_chapter_version_id', 'sourceChapterVersionId'),
        }),
      }); break
      case 'timeline_events': targetId = await this.writer.createTimelineEventDraft({
        ...base,
        eventKey: aliasText(record, 'event_key', 'eventKey') ?? text(record, 'eventKey'),
        title: aliasText(record, 'title') ?? text(record, 'title'),
        ...optional({
          description: aliasText(record, 'description'),
          sequenceNo: aliasInteger(record, 'sequence_no', 'sequenceNo'),
          attributes: aliasObject(record, 'attributes', 'attributes_jsonb'),
          sourceChapterId: aliasText(record, 'source_chapter_id', 'sourceChapterId'),
          sourceChapterVersionId: aliasText(record, 'source_chapter_version_id', 'sourceChapterVersionId'),
        }),
      }); break
      case 'chapters': targetId = await this.writer.createChapterDraft({ ...base, chapterNo: aliasInteger(record, 'chapter_no', 'chapterNo') ?? integer(record, 'chapterNo'), title: aliasText(record, 'title') ?? text(record, 'title'), ...optional({ summary: aliasText(record, 'summary') }) }); break
      case 'chapter_versions': {
        const contentStorageKind = aliasText(record, 'content_storage_kind', 'contentStorageKind') ?? text(record, 'contentStorageKind')
        if (contentStorageKind !== 'postgres_text' && contentStorageKind !== 'object_storage') throw new Error('contentStorageKind is invalid for generated chapter_versions')
        const input: ChapterVersionDraftInput = {
          ...base,
          chapterId: resolvedId(record, ['chapterId', 'chapter_id'], ['chapterRef', 'chapter_ref'], references),
          versionNo: aliasInteger(record, 'version_no', 'versionNo') ?? integer(record, 'versionNo'),
          contentSha256: aliasText(record, 'content_sha256', 'contentSha256') ?? text(record, 'contentSha256'),
          contentBytes: aliasInteger(record, 'content_bytes', 'contentBytes') ?? integer(record, 'contentBytes'),
          contentStorageKind,
          ...optional({ contentText: aliasText(record, 'content_text', 'contentText'), contentObjectKey: aliasText(record, 'content_object_key', 'contentObjectKey'), summary: aliasText(record, 'summary') }),
        }
        targetId = await this.writer.createChapterVersionDraft(input)
        break
      }
      case 'chapter_summaries': {
        const summaryKind = aliasText(record, 'summary_kind', 'summaryKind') ?? text(record, 'summaryKind')
        if (summaryKind !== 'short' && summaryKind !== 'detailed' && summaryKind !== 'facts') throw new Error('summaryKind is invalid for generated chapter_summaries')
        targetId = await this.writer.createChapterSummaryDraft({
          ...base,
          chapterId: resolvedId(record, ['chapterId', 'chapter_id'], ['chapterRef', 'chapter_ref'], references),
          chapterVersionId: resolvedId(record, ['chapterVersionId', 'chapter_version_id'], ['chapterVersionRef', 'chapter_version_ref'], references),
          summaryKind,
          contentText: aliasText(record, 'content_text', 'contentText') ?? text(record, 'contentText'),
          contentSha256: aliasText(record, 'content_sha256', 'contentSha256') ?? text(record, 'contentSha256'),
        })
        break
      }
      case 'character_skills': {
        const characterId = resolvedId(record, ['characterId', 'character_id'], ['characterRef', 'character_ref'], references)
        const skillId = resolvedId(record, ['skillId', 'skill_id'], ['skillRef', 'skill_ref'], references)
        targetId = await this.writer.createCharacterSkillDraft({ ...base, characterId, skillId, relationType: aliasText(record, 'relation_type', 'relationType') ?? text(record, 'relationType'), ...Object.fromEntries(Object.entries({ sourceVersionNo: aliasInteger(record, 'source_version_no', 'sourceVersionNo'), attributes: aliasObject(record, 'attributes', 'attributes_jsonb') }).filter(([, value]) => value !== undefined)) })
        break
      }
      case 'entity_relations': {
        const input: EntityRelationDraftInput = {
          ...base,
          sourceEntityType: aliasText(record, 'source_entity_type', 'sourceEntityType') ?? text(record, 'sourceEntityType'), sourceEntityId: resolvedId(record, ['sourceEntityId', 'source_entity_id'], ['sourceEntityRef', 'source_entity_ref'], references),
          targetEntityType: aliasText(record, 'target_entity_type', 'targetEntityType') ?? text(record, 'targetEntityType'), targetEntityId: resolvedId(record, ['targetEntityId', 'target_entity_id'], ['targetEntityRef', 'target_entity_ref'], references),
          relationType: aliasText(record, 'relation_type', 'relationType') ?? text(record, 'relationType'), ...Object.fromEntries(Object.entries({ strength: aliasInteger(record, 'strength'), sourceVersionNo: aliasInteger(record, 'source_version_no', 'sourceVersionNo'), attributes: aliasObject(record, 'attributes', 'attributes_jsonb') }).filter(([, value]) => value !== undefined)),
        }
        targetId = await this.writer.createEntityRelationDraft(input)
        break
      }
      default: throw new Error(`unsupported generated target type: ${type}`)
    }
    const clientKey = record.clientKey
    if (typeof clientKey === 'string' && clientKey.trim() !== '') references.set(clientKey, targetId)
    return targetId
  }

}
