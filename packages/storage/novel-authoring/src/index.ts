import {
  and,
  asc,
  chapterVersions,
  chapters,
  characters,
  characterSkills,
  chapterSummaries,
  eq,
  entityRelations,
  factions,
  generationProposals,
  generationRuns,
  generationContextItems,
  items,
  isNull,
  locations,
  outlines,
  skills,
  sql,
  storylines,
  storyFacts,
  timelineEvents,
  novels,
  workspaceMembers,
  workspaces,
  withRequestContext,
  type DatabaseClient,
  type DshDatabase,
} from '@deepseek-ai/dsh-database-postgres'
import { canPerform, type AuthPrincipal } from '@deepseek-ai/dsh-user-auth'

function requestContext(principal: AuthPrincipal): {
  userId: string
  workspaceId: string
  actorType: 'user' | 'agent'
  agentPrincipalId?: string
} {
  return {
    userId: principal.userId,
    workspaceId: principal.workspaceId,
    actorType: principal.actorType,
    ...(principal.agentPrincipalId === undefined ? {} : { agentPrincipalId: principal.agentPrincipalId }),
  }
}

/** Fixed entity types that the model may author as records. */
export type NovelDraftTargetType =
  | 'outlines'
  | 'characters'
  | 'skills'
  | 'locations'
  | 'factions'
  | 'items'
  | 'storylines'
  | 'entity_relations'
  | 'character_skills'
  | 'chapters'
  | 'chapter_versions'
  | 'chapter_summaries'
  | 'story_facts'
  | 'timeline_events'

/** Safe structured payload captured alongside a model-generated proposal. */
export interface DraftProposalInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly targetType: NovelDraftTargetType
  readonly targetId?: string
  readonly operation: 'create' | 'update' | 'link'
  readonly baseVersionNo?: number
  readonly proposedContent: Record<string, unknown>
  readonly validationResult: Record<string, unknown>
  readonly conflictResult?: Record<string, unknown>
  readonly idempotencyKey: string
}

/** Input needed to create an AI generation run. */
export interface GenerationRunInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly model: string
  readonly promptVersion: string
  readonly sourceSessionId: string
  readonly idempotencyKey: string
  /** Durable user request payload used when a worker resumes a queued run. */
  readonly instruction?: string
  readonly contextLimit?: number
}

/** Complete queued request reconstructed by an authenticated generation worker. */
export interface QueuedGenerationRequest extends GenerationRunInput {
  readonly generationRunId: string
  readonly instruction: string
  readonly contextLimit: number
}

/** States persisted for one AI generation task. */
export type GenerationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Validate the state machine enforced by the PostgreSQL generation-run trigger. */
export function assertGenerationRunTransition(from: GenerationRunStatus, to: GenerationRunStatus): void {
  const allowed: Record<GenerationRunStatus, readonly GenerationRunStatus[]> = {
    queued: ['running', 'cancelled'],
    running: ['running', 'completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  }
  if (!allowed[from].includes(to)) throw new Error('invalid generation run state transition')
}

/** Proposal lifecycle states persisted by the review and publication flow. */
export type ProposalStatus = 'draft' | 'approved' | 'rejected' | 'published' | 'expired'

/** Actors allowed to move a proposal between review states. */
export type ProposalReviewActor = 'user' | 'service' | 'agent'

/** Validate proposal transitions before the database trigger evaluates them. */
export function assertProposalReviewTransition(
  from: ProposalStatus,
  to: ProposalStatus,
  actor: ProposalReviewActor,
): void {
  const allowed = actor === 'service'
    ? from === 'approved' && to === 'published'
    : actor === 'user'
      ? (from === 'draft' && ['approved', 'rejected', 'expired'].includes(to)) || (from === 'rejected' && to === 'draft')
      : false
  if (!allowed) throw new Error('invalid proposal transition')
}

/** Reject publication or rollback when the caller observed an older version. */
export function assertOptimisticVersion(currentVersionNo: number, expectedVersionNo: number): void {
  if (!Number.isSafeInteger(currentVersionNo) || currentVersionNo < 1
    || !Number.isSafeInteger(expectedVersionNo) || expectedVersionNo < 1
    || currentVersionNo !== expectedVersionNo) {
    throw new Error('version conflict')
  }
}

/** Input for a model-created character draft. */
export interface CharacterDraftInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly name: string
  readonly summary?: string
  readonly attributes?: Record<string, unknown>
  readonly idempotencyKey: string
}

/** Common input for fixed named entities created by the model as drafts. */
export interface NamedEntityDraftInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly name: string
  readonly summary?: string
  readonly attributes?: Record<string, unknown>
  readonly idempotencyKey: string
}

/** Input for an AI-created relation between two fixed novel entities. */
export interface EntityRelationDraftInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly sourceEntityType: string
  readonly sourceEntityId: string
  readonly targetEntityType: string
  readonly targetEntityId: string
  readonly relationType: string
  readonly strength?: number
  readonly sourceVersionNo?: number
  readonly attributes?: Record<string, unknown>
  readonly idempotencyKey: string
}

/** Input for an AI-created character-to-skill link. */
export interface CharacterSkillDraftInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly characterId: string
  readonly skillId: string
  readonly relationType: string
  readonly sourceVersionNo?: number
  readonly attributes?: Record<string, unknown>
  readonly idempotencyKey: string
}

/** Input for an AI-extracted world fact. */
export interface StoryFactDraftInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly factKey: string
  readonly statement: string
  readonly attributes?: Record<string, unknown>
  readonly sourceChapterId?: string
  readonly sourceChapterVersionId?: string
  readonly idempotencyKey: string
}

/** Input for an AI-extracted timeline event. */
export interface TimelineEventDraftInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly eventKey: string
  readonly title: string
  readonly description?: string
  readonly sequenceNo?: number
  readonly attributes?: Record<string, unknown>
  readonly sourceChapterId?: string
  readonly sourceChapterVersionId?: string
  readonly idempotencyKey: string
}

/** Input for a generated chapter summary. */
export interface ChapterSummaryDraftInput {
  readonly generationRunId: string
  readonly workspaceId: string
  readonly novelId: string
  readonly chapterId: string
  readonly chapterVersionId: string
  readonly summaryKind: 'short' | 'detailed' | 'facts'
  readonly contentText: string
  readonly contentSha256: string
  readonly idempotencyKey: string
}

/** Reject writes that are not initiated by a server-resolved editor or agent. */
export function assertDraftAuthor(principal: AuthPrincipal): void {
  if (!canPerform(principal, 'draft:create')) throw new Error('workspace editor permission is required')
  if (principal.actorType === 'agent' && principal.agentPrincipalId === undefined) {
    throw new Error('agent draft writes require an agent principal')
  }
}

/** AI materialization and run lifecycle updates must use the bound worker role. */
export function assertGenerationWorker(principal: AuthPrincipal): void {
  if (principal.actorType !== 'agent' || principal.agentPrincipalId === undefined) {
    throw new Error('generation worker requires an agent principal')
  }
  if (!canPerform(principal, 'draft:create')) throw new Error('workspace editor permission is required')
}

/** Database-backed authoring service. It never executes model-supplied SQL or DDL. */
export class NovelAuthoringService {
  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly principal: AuthPrincipal,
  ) {}

  /** Create a queued generation run under the current workspace and actor context. */
  async createGenerationRun(input: GenerationRunInput): Promise<string> {
    assertDraftAuthor(this.principal)
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    const instruction = input.instruction?.trim() ?? ''
    const contextLimit = input.contextLimit ?? 8
    if (input.instruction !== undefined && instruction === '') throw new Error('generation instruction is required')
    if (!Number.isSafeInteger(contextLimit) || contextLimit < 0 || contextLimit > 128) throw new Error('generation context limit is invalid')
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: generationRuns.id })
        .from(generationRuns)
        .where(and(eq(generationRuns.workspaceId, input.workspaceId), eq(generationRuns.idempotencyKey, input.idempotencyKey)))
        .limit(1)
      if (existing !== undefined) return existing.id
      const [run] = await db.insert(generationRuns).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        initiatedByUserId: this.principal.userId,
        agentPrincipalId: this.principal.agentPrincipalId ?? 'user-request',
        model: input.model,
        promptVersion: input.promptVersion,
        sourceSessionId: input.sourceSessionId,
        instruction,
        contextLimit,
        idempotencyKey: input.idempotencyKey,
        status: 'queued',
      }).returning({ id: generationRuns.id })
      if (run === undefined) throw new Error('generation run was not created')
      return run.id
    })
  }

  /** Load the durable request payload for a worker resuming a queued run. */
  async getQueuedGenerationRequest(input: {
    readonly workspaceId: string
    readonly generationRunId: string
  }): Promise<QueuedGenerationRequest> {
    assertGenerationWorker(this.principal)
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    return this.withContext(async (db) => {
      const [candidate] = await db.select({ novelId: generationRuns.novelId }).from(generationRuns).where(and(
        eq(generationRuns.workspaceId, input.workspaceId),
        eq(generationRuns.id, input.generationRunId),
      )).limit(1)
      if (candidate === undefined) throw new Error('generation run was not found')
      const claim = await db.execute(sql`SELECT ai.claim_generation_run(
        ${input.workspaceId}::uuid, ${candidate.novelId}::uuid, ${input.generationRunId}::uuid
      ) AS claimed`)
      if (!claim.rows[0]?.claimed) throw new Error('generation run is already claimed or unavailable')
      const [run] = await db.select().from(generationRuns).where(and(
        eq(generationRuns.workspaceId, input.workspaceId),
        eq(generationRuns.id, input.generationRunId),
      )).limit(1)
      if (run === undefined) throw new Error('generation run was not found')
      if (run.instruction.trim() === '') throw new Error('queued generation instruction is missing')
      return {
        workspaceId: run.workspaceId,
        novelId: run.novelId,
        model: run.model,
        promptVersion: run.promptVersion,
        sourceSessionId: run.sourceSessionId ?? '00000000-0000-0000-0000-000000000000',
        idempotencyKey: run.idempotencyKey,
        instruction: run.instruction,
        contextLimit: run.contextLimit,
        generationRunId: run.id,
      }
    })
  }

  /** Read a generation run status within the authenticated workspace. */
  async getGenerationRunStatus(input: {
    readonly workspaceId: string
    readonly generationRunId: string
  }): Promise<GenerationRunStatus> {
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    return this.withContext(async (db) => {
      const [run] = await db.select({ status: generationRuns.status })
        .from(generationRuns)
        .where(and(eq(generationRuns.workspaceId, input.workspaceId), eq(generationRuns.id, input.generationRunId)))
        .limit(1)
      if (run === undefined) throw new Error('generation run was not found')
      return run.status as GenerationRunStatus
    })
  }

  /** Advance a generation run without allowing worker-owned inputs to change. */
  async updateGenerationRunStatus(input: {
    readonly workspaceId: string
    readonly generationRunId: string
    readonly status: GenerationRunStatus
    readonly errorCode?: string
    readonly errorSummary?: string
    readonly heartbeatAt?: Date
    readonly completedAt?: Date
  }): Promise<void> {
    assertGenerationWorker(this.principal)
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    await this.withContext(async (db) => {
      const [run] = await db.select({ status: generationRuns.status })
        .from(generationRuns)
        .where(and(eq(generationRuns.workspaceId, input.workspaceId), eq(generationRuns.id, input.generationRunId)))
        .limit(1)
      if (run === undefined) throw new Error('generation run was not found')
      assertGenerationRunTransition(run.status as GenerationRunStatus, input.status)
      if (input.errorSummary !== undefined && input.errorSummary.length > 512) {
        throw new Error('generation run error summary is too long')
      }
      const now = new Date()
      const terminal = input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled'
      await db.update(generationRuns).set({
        status: input.status,
        heartbeatAt: input.status === 'running' ? (input.heartbeatAt ?? now) : undefined,
        completedAt: terminal ? (input.completedAt ?? now) : null,
        errorCode: input.errorCode,
        errorSummary: input.errorSummary,
      }).where(and(eq(generationRuns.workspaceId, input.workspaceId), eq(generationRuns.id, input.generationRunId)))
    })
  }

  /** Persist a draft proposal; publication is intentionally unavailable on this service. */
  async createDraftProposal(input: DraftProposalInput): Promise<string> {
    assertGenerationWorker(this.principal)
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (input.operation === 'update' && (input.baseVersionNo === undefined || input.baseVersionNo < 1)) {
      throw new Error('updates require a positive base version')
    }
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: generationProposals.id })
        .from(generationProposals)
        .where(and(eq(generationProposals.workspaceId, input.workspaceId), eq(generationProposals.idempotencyKey, input.idempotencyKey)))
        .limit(1)
      if (existing !== undefined) return existing.id
      const [proposal] = await db.insert(generationProposals).values({
        generationRunId: input.generationRunId,
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        targetType: input.targetType,
        targetId: input.targetId,
        operation: input.operation,
        baseVersionNo: input.baseVersionNo,
        proposedContent: input.proposedContent,
        validationResult: input.validationResult,
        conflictResult: input.conflictResult,
        status: 'draft',
        idempotencyKey: input.idempotencyKey,
      }).returning({ id: generationProposals.id })
      if (proposal === undefined) throw new Error('draft proposal was not created')
      return proposal.id
    })
  }

  /** Create a draft character and return an existing record for an idempotent retry. */
  async createCharacterDraft(input: CharacterDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: characters.id })
        .from(characters)
        .where(and(eq(characters.workspaceId, input.workspaceId), eq(characters.sourceIdempotencyKey, input.idempotencyKey)))
        .limit(1)
      if (existing !== undefined) return existing.id
      const [character] = await db.insert(characters).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        name: input.name,
        summary: input.summary,
        status: 'draft',
        attributesJsonb: input.attributes ?? {},
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: characters.id })
      if (character === undefined) throw new Error('character draft was not created')
      return character.id
    })
  }

  /** Create an idempotent draft relation between two fixed entities. */
  async createEntityRelationDraft(input: EntityRelationDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: entityRelations.id }).from(entityRelations).where(and(
        eq(entityRelations.workspaceId, input.workspaceId),
        eq(entityRelations.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [relation] = await db.insert(entityRelations).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        targetEntityType: input.targetEntityType,
        targetEntityId: input.targetEntityId,
        relationType: input.relationType,
        status: 'draft',
        strength: input.strength,
        sourceVersionNo: input.sourceVersionNo,
        attributesJsonb: input.attributes ?? {},
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: entityRelations.id })
      if (relation === undefined) throw new Error('entity relation draft was not created')
      return relation.id
    })
  }

  /** Create an idempotent draft character-to-skill association. */
  async createCharacterSkillDraft(input: CharacterSkillDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: characterSkills.id }).from(characterSkills).where(and(
        eq(characterSkills.workspaceId, input.workspaceId),
        eq(characterSkills.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [link] = await db.insert(characterSkills).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        characterId: input.characterId,
        skillId: input.skillId,
        relationType: input.relationType,
        status: 'draft',
        sourceVersionNo: input.sourceVersionNo,
        attributesJsonb: input.attributes ?? {},
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: characterSkills.id })
      if (link === undefined) throw new Error('character skill draft was not created')
      return link.id
    })
  }

  /** Create an idempotent draft world fact. */
  async createStoryFactDraft(input: StoryFactDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: storyFacts.id }).from(storyFacts).where(and(
        eq(storyFacts.workspaceId, input.workspaceId),
        eq(storyFacts.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [fact] = await db.insert(storyFacts).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        factKey: input.factKey,
        statement: input.statement,
        status: 'draft',
        attributesJsonb: input.attributes ?? {},
        sourceChapterId: input.sourceChapterId,
        sourceChapterVersionId: input.sourceChapterVersionId,
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: storyFacts.id })
      if (fact === undefined) throw new Error('story fact draft was not created')
      return fact.id
    })
  }

  /** Create an idempotent draft timeline event. */
  async createTimelineEventDraft(input: TimelineEventDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: timelineEvents.id }).from(timelineEvents).where(and(
        eq(timelineEvents.workspaceId, input.workspaceId),
        eq(timelineEvents.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [event] = await db.insert(timelineEvents).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        eventKey: input.eventKey,
        title: input.title,
        description: input.description,
        sequenceNo: input.sequenceNo,
        status: 'draft',
        attributesJsonb: input.attributes ?? {},
        sourceChapterId: input.sourceChapterId,
        sourceChapterVersionId: input.sourceChapterVersionId,
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: timelineEvents.id })
      if (event === undefined) throw new Error('timeline event draft was not created')
      return event.id
    })
  }

  /** Create an idempotent draft summary for a persisted chapter version. */
  async createChapterSummaryDraft(input: ChapterSummaryDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    if (!/^[0-9a-f]{64}$/u.test(input.contentSha256)) throw new Error('summary SHA-256 must be a 64-character hexadecimal digest')
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: chapterSummaries.id }).from(chapterSummaries).where(and(
        eq(chapterSummaries.workspaceId, input.workspaceId),
        eq(chapterSummaries.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [summary] = await db.insert(chapterSummaries).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterVersionId: input.chapterVersionId,
        summaryKind: input.summaryKind,
        contentText: input.contentText,
        contentSha256: input.contentSha256,
        status: 'draft',
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: chapterSummaries.id })
      if (summary === undefined) throw new Error('chapter summary draft was not created')
      return summary.id
    })
  }

  /** Create an idempotent draft skill. */
  async createSkillDraft(input: NamedEntityDraftInput): Promise<string> {
    return this.createNamedDraft(input, skills)
  }

  /** Create an idempotent draft location. */
  async createLocationDraft(input: NamedEntityDraftInput): Promise<string> {
    return this.createNamedDraft(input, locations)
  }

  /** Create an idempotent draft faction. */
  async createFactionDraft(input: NamedEntityDraftInput): Promise<string> {
    return this.createNamedDraft(input, factions)
  }

  /** Create an idempotent draft item. */
  async createItemDraft(input: NamedEntityDraftInput): Promise<string> {
    return this.createNamedDraft(input, items)
  }

  /** Create an idempotent draft storyline. */
  async createStorylineDraft(input: NamedEntityDraftInput): Promise<string> {
    return this.createNamedDraft(input, storylines)
  }

  /** Create an idempotent draft outline with structured content. */
  async createOutlineDraft(input: NamedEntityDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: outlines.id }).from(outlines).where(and(
        eq(outlines.workspaceId, input.workspaceId),
        eq(outlines.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [outline] = await db.insert(outlines).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        title: input.name,
        contentJsonb: input.attributes ?? {},
        status: 'draft',
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: outlines.id })
      if (outline === undefined) throw new Error('outline draft was not created')
      return outline.id
    })
  }

  private async createNamedDraft(
    input: NamedEntityDraftInput,
    table: typeof skills | typeof locations | typeof factions | typeof items | typeof storylines,
  ): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: table.id }).from(table).where(and(
        eq(table.workspaceId, input.workspaceId),
        eq(table.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const values = {
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        name: input.name,
        summary: input.summary,
        status: 'draft' as const,
        attributesJsonb: input.attributes ?? {},
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }
      const [entity] = await db.insert(table).values(values).returning({ id: table.id })
      if (entity === undefined) throw new Error('novel draft was not created')
      return entity.id
    })
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
  }

  private withContext<T>(callback: (database: DshDatabase) => Promise<T>): Promise<T> {
    return withRequestContext(this.database, {
      userId: this.principal.userId,
      workspaceId: this.principal.workspaceId,
      actorType: this.principal.actorType,
      ...(this.principal.agentPrincipalId === undefined ? {} : { agentPrincipalId: this.principal.agentPrincipalId }),
    }, callback)
  }
}

/** User-facing proposal review operations; publication remains service-role controlled. */
export class ProposalReviewService {
  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly principal: AuthPrincipal,
  ) {}

  /** Bind a newly-created proposal to the draft record it created. */
  async bindTarget(input: { readonly workspaceId: string; readonly proposalId: string; readonly targetId: string }): Promise<void> {
    this.assertUser()
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'content:write')) throw new Error('editor permission is required')
    await withRequestContext(this.database, this.context(), async (db) => {
      const [proposal] = await db.select({ status: generationProposals.status, targetId: generationProposals.targetId })
        .from(generationProposals)
        .where(and(eq(generationProposals.workspaceId, input.workspaceId), eq(generationProposals.id, input.proposalId)))
        .limit(1)
      if (proposal === undefined || proposal.status !== 'draft' || proposal.targetId !== null) {
        throw new Error('proposal target cannot be bound')
      }
      await db.update(generationProposals).set({ targetId: input.targetId }).where(and(
        eq(generationProposals.workspaceId, input.workspaceId),
        eq(generationProposals.id, input.proposalId),
      ))
    })
  }

  /** Approve, reject, or reopen a proposal without changing its generated content. */
  async review(input: {
    readonly workspaceId: string
    readonly proposalId: string
    readonly decision: 'approved' | 'rejected' | 'expired' | 'draft'
  }): Promise<void> {
    this.assertUser()
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (input.decision === 'approved' || input.decision === 'expired') {
      if (!canPerform(this.principal, 'proposal:publish')) throw new Error('owner or administrator permission is required')
    } else if (!canPerform(this.principal, 'content:write')) {
      throw new Error('editor permission is required')
    }
    await withRequestContext(this.database, this.context(), async (db) => {
      const [proposal] = await db.select({ status: generationProposals.status, targetId: generationProposals.targetId })
        .from(generationProposals)
        .where(and(eq(generationProposals.workspaceId, input.workspaceId), eq(generationProposals.id, input.proposalId)))
        .limit(1)
      if (proposal === undefined) throw new Error('proposal was not found')
      assertProposalReviewTransition(proposal.status as ProposalStatus, input.decision, 'user')
      if (input.decision !== 'draft' && proposal.targetId === null) throw new Error('proposal target must be bound before review')
      const now = new Date()
      await db.update(generationProposals).set({
        status: input.decision,
        reviewedByUserId: input.decision === 'draft' ? null : this.principal.userId,
        reviewedAt: input.decision === 'draft' ? null : now,
        publishedAt: null,
      }).where(and(eq(generationProposals.workspaceId, input.workspaceId), eq(generationProposals.id, input.proposalId)))
    })
  }

  private context(): {
    userId: string
    workspaceId: string
    actorType: 'user'
  } {
    return { userId: this.principal.userId, workspaceId: this.principal.workspaceId, actorType: 'user' }
  }

  private assertUser(): void {
    if (this.principal.actorType !== 'user') throw new Error('agents cannot review proposals')
  }
}

/** Input for an atomic, reviewer-controlled publication. */
export interface ProposalPublicationInput {
  readonly workspaceId: string
  readonly proposalId: string
}

/** Input for restoring a previously published version. */
export interface ProposalRollbackInput {
  readonly workspaceId: string
  readonly targetType: string
  readonly targetId: string
  readonly versionNo: number
}

/** Calls the database-owned publication and rollback transactions. */
export class ProposalPublicationService {
  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly principal: AuthPrincipal,
  ) {}

  /** Publish a reviewed proposal through the restricted service database role. */
  async publish(input: ProposalPublicationInput): Promise<void> {
    this.assertReviewer(input.workspaceId)
    await withRequestContext(this.database, this.context(), async (db) => {
      await db.execute(sql`SELECT ai.publish_generation_proposal(${input.workspaceId}::uuid, ${input.proposalId}::uuid)`)
    })
  }

  /** Restore a prior version through a transaction that emits an audit event. */
  async rollback(input: ProposalRollbackInput): Promise<void> {
    this.assertReviewer(input.workspaceId)
    if (!Number.isSafeInteger(input.versionNo) || input.versionNo < 1) throw new Error('version number must be positive')
    await withRequestContext(this.database, this.context(), async (db) => {
      await db.execute(sql`SELECT ai.rollback_entity_version(
        ${input.workspaceId}::uuid,
        ${input.targetType},
        ${input.targetId}::uuid,
        ${input.versionNo}
      )`)
    })
  }

  private assertReviewer(workspaceId: string): void {
    if (this.principal.actorType !== 'user' || workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'proposal:publish')) throw new Error('owner or administrator permission is required')
  }

  private context(): {
    userId: string
    workspaceId: string
    actorType: 'user'
  } {
    return { userId: this.principal.userId, workspaceId: this.principal.workspaceId, actorType: 'user' }
  }
}

/** Input for creating a user-owned workspace. */
export interface WorkspaceCreateInput {
  readonly name: string
}

/** Input for creating a novel inside the active workspace. */
export interface NovelCreateInput {
  readonly workspaceId: string
  readonly title: string
  readonly attributes?: Record<string, unknown>
}

/** Database-backed workspace and novel lifecycle operations. */
export class WorkspaceAuthoringService {
  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly principal: AuthPrincipal,
  ) {}

  /** Create a workspace and its owner membership atomically. */
  async createWorkspace(input: WorkspaceCreateInput): Promise<string> {
    this.assertUserActor()
    if (!input.name.trim()) throw new Error('workspace name is required')
    return withRequestContext(this.database, requestContext(this.principal), async (db) => {
      const [workspace] = await db.insert(workspaces).values({
        ownerUserId: this.principal.userId,
        name: input.name.trim(),
        status: 'active',
      }).returning({ id: workspaces.id })
      if (workspace === undefined) throw new Error('workspace was not created')
      await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: this.principal.userId,
        role: 'owner',
      })
      return workspace.id
    })
  }

  /** List only workspaces visible to the authenticated principal through RLS. */
  async listWorkspaces(): Promise<readonly typeof workspaces.$inferSelect[]> {
    return withRequestContext(this.database, requestContext(this.principal), async db => db.select().from(workspaces))
  }

  /** Create a novel in the selected workspace after server-side role checking. */
  async createNovel(input: NovelCreateInput): Promise<string> {
    this.assertUserActor()
    if (input.workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'content:write')) throw new Error('editor permission is required')
    if (!input.title.trim()) throw new Error('novel title is required')
    return withRequestContext(this.database, requestContext(this.principal), async (db) => {
      const [novel] = await db.insert(novels).values({
        workspaceId: input.workspaceId,
        title: input.title.trim(),
        status: 'draft',
        attributesJsonb: input.attributes ?? {},
        createdByUserId: this.principal.userId,
      }).returning({ id: novels.id })
      if (novel === undefined) throw new Error('novel was not created')
      return novel.id
    })
  }

  /** Change a member role; ownership changes remain exclusively database-guarded. */
  async changeMemberRole(workspaceId: string, userId: string, role: 'admin' | 'editor' | 'member'): Promise<void> {
    this.assertUserActor()
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'workspace:manage')) throw new Error('workspace administrator permission is required')
    await withRequestContext(this.database, requestContext(this.principal), async (db) => {
      await db.update(workspaceMembers).set({ role }).where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ))
    })
  }

  /** Add a non-owner member through the workspace RLS policy. */
  async inviteMember(workspaceId: string, userId: string, role: 'admin' | 'editor' | 'member'): Promise<void> {
    this.assertUserActor()
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'workspace:manage')) throw new Error('workspace administrator permission is required')
    await withRequestContext(this.database, requestContext(this.principal), async (db) => {
      await db.insert(workspaceMembers).values({ workspaceId, userId, role })
    })
  }

  /** Revoke an active membership without deleting its audit history. */
  async revokeMember(workspaceId: string, userId: string): Promise<void> {
    this.assertUserActor()
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'workspace:manage')) throw new Error('workspace administrator permission is required')
    await withRequestContext(this.database, requestContext(this.principal), async (db) => {
      await db.update(workspaceMembers).set({ revokedAt: new Date() }).where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ))
    })
  }

  /** List active memberships visible to the current workspace context. */
  async listMembers(workspaceId: string): Promise<readonly typeof workspaceMembers.$inferSelect[]> {
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'content:read')) throw new Error('workspace membership is required')
    return withRequestContext(this.database, requestContext(this.principal), async db => db.select().from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      isNull(workspaceMembers.revokedAt),
    )))
  }

  /** Transfer ownership through the database-guarded ownership procedure. */
  async transferOwnership(workspaceId: string, newOwnerUserId: string): Promise<void> {
    this.assertUserActor()
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'workspace:manage')) throw new Error('workspace administrator permission is required')
    await withRequestContext(this.database, requestContext(this.principal), async (db) => {
      await db.execute(sql`SELECT app.transfer_workspace_owner(${workspaceId}::uuid, ${newOwnerUserId}::uuid)`)
    })
  }

  /** Archive a workspace while retaining its contents for recovery. */
  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.setWorkspaceStatus(workspaceId, 'archived')
  }

  /** Restore an archived workspace. */
  async restoreWorkspace(workspaceId: string): Promise<void> {
    await this.setWorkspaceStatus(workspaceId, 'active')
  }

  private async setWorkspaceStatus(workspaceId: string, status: 'active' | 'archived'): Promise<void> {
    this.assertUserActor()
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (!canPerform(this.principal, 'workspace:manage')) throw new Error('workspace administrator permission is required')
    await withRequestContext(this.database, requestContext(this.principal), async (db) => {
      await db.update(workspaces).set({ status, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId))
    })
  }

  private assertUserActor(): void {
    if (this.principal.actorType !== 'user') throw new Error('only users may manage workspaces')
  }
}

/** Input for a durable chapter draft. */
export interface ChapterDraftInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly generationRunId: string
  readonly chapterNo: number
  readonly title: string
  readonly summary?: string
  readonly idempotencyKey: string
}

/** Input for a durable chapter version draft. */
export interface ChapterVersionDraftInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly chapterId: string
  readonly generationRunId: string
  readonly versionNo: number
  readonly contentSha256: string
  readonly contentBytes: number
  readonly contentStorageKind: 'postgres_text' | 'object_storage'
  readonly contentText?: string
  readonly contentObjectKey?: string
  readonly summary?: string
  readonly idempotencyKey: string
}

/** Storage metadata checked before a chapter body is persisted. */
export interface ChapterContentStorageInput {
  readonly contentSha256: string
  readonly contentBytes: number
  readonly contentStorageKind: 'postgres_text' | 'object_storage'
  readonly contentText?: string
  readonly contentObjectKey?: string
}

/** Host-owned object storage capability for chapters larger than 1 MiB. */
export interface ChapterObjectStorage {
  /** Verify the configured bucket/provider is reachable before metadata is committed. */
  assertAvailable(): Promise<void>
}

/** Reject chapter metadata that could make a persisted body unrecoverable. */
export function validateChapterContentStorage(input: ChapterContentStorageInput): void {
  if (!/^[0-9a-f]{64}$/u.test(input.contentSha256)) throw new Error('content SHA-256 must be a 64-character hexadecimal digest')
  if (!Number.isSafeInteger(input.contentBytes) || input.contentBytes < 0) {
    throw new Error('content byte length must be a non-negative integer')
  }
  if (input.contentStorageKind === 'postgres_text') {
    if (input.contentText === undefined || input.contentObjectKey !== undefined) {
      throw new Error('PostgreSQL text storage requires content text and no object key')
    }
    if (input.contentBytes > 1024 * 1024) throw new Error('object storage is required for chapters over 1 MiB')
    if (Buffer.byteLength(input.contentText, 'utf8') !== input.contentBytes) {
      throw new Error('content byte length does not match the chapter text')
    }
    return
  }
  if (input.contentObjectKey === undefined || input.contentObjectKey.trim() === '' || input.contentText !== undefined) {
    throw new Error('object storage requires a non-empty object key and no inline text')
  }
  if (input.contentBytes <= 1024 * 1024) throw new Error('object storage is required only for chapters over 1 MiB')
}

/** One source selected for an AI generation context. */
export interface GenerationContextItemInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly generationRunId: string
  readonly sourceType: string
  readonly sourceId: string
  readonly rank: number
  readonly excerptHash: string
  readonly tokenCount: number
  readonly selectionReason: string
}

/** Candidate context item returned by a domain query before model selection. */
export interface ContextCandidate {
  readonly sourceType: string
  readonly sourceId: string
  /** Optional repository-returned tenant coordinates. When present they are verified before use. */
  readonly workspaceId?: string
  readonly novelId?: string
  readonly status: 'draft' | 'published' | 'archived' | 'deleted'
  readonly relevanceScore: number
  readonly recencyScore: number
  readonly excerptHash?: string
  readonly excerpt?: string
  readonly tokenCount?: number
  readonly selectionReason?: string
}

/** Input for selecting and persisting the exact context used by one generation. */
export interface GenerationContextSelectionInput {
  readonly workspaceId: string
  readonly novelId: string
  readonly generationRunId: string
  readonly candidates: readonly ContextCandidate[]
  readonly limit: number
}

/** Select a bounded, deterministic context set for a generation run. */
export function rankContextCandidates(candidates: readonly ContextCandidate[], limit: number): ContextCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('context limit must be a non-negative integer')
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(item => item.candidate.status !== 'deleted' && item.candidate.status !== 'archived')
    .sort((left, right) => {
      const publishedDifference = Number(right.candidate.status === 'published') - Number(left.candidate.status === 'published')
      if (publishedDifference !== 0) return publishedDifference
      const relevanceDifference = right.candidate.relevanceScore - left.candidate.relevanceScore
      if (relevanceDifference !== 0) return relevanceDifference
      const recencyDifference = right.candidate.recencyScore - left.candidate.recencyScore
      return recencyDifference !== 0 ? recencyDifference : left.index - right.index
    })
    .slice(0, limit)
    .map(item => item.candidate)
}

/** Durable chapter and context persistence for cross-session continuation. */
export class LongformAuthoringService {
  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly principal: AuthPrincipal,
    private readonly objectStorage?: ChapterObjectStorage,
  ) {}

  /** Create or resolve an idempotent chapter draft. */
  async createChapterDraft(input: ChapterDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: chapters.id }).from(chapters).where(and(
        eq(chapters.workspaceId, input.workspaceId),
        eq(chapters.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [chapter] = await db.insert(chapters).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        chapterNo: input.chapterNo,
        title: input.title,
        summary: input.summary,
        status: 'draft',
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: chapters.id })
      if (chapter === undefined) throw new Error('chapter draft was not created')
      return chapter.id
    })
  }

  /** Persist a chapter body under PostgreSQL/object-storage integrity checks. */
  async createChapterVersionDraft(input: ChapterVersionDraftInput): Promise<string> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    validateChapterContentStorage(input)
    if (input.contentStorageKind === 'object_storage') {
      if (this.objectStorage === undefined) throw new Error('object storage is required for large chapter versions')
      await this.objectStorage.assertAvailable()
    }
    return this.withContext(async (db) => {
      const [existing] = await db.select({ id: chapterVersions.id }).from(chapterVersions).where(and(
        eq(chapterVersions.workspaceId, input.workspaceId),
        eq(chapterVersions.sourceIdempotencyKey, input.idempotencyKey),
      )).limit(1)
      if (existing !== undefined) return existing.id
      const [version] = await db.insert(chapterVersions).values({
        workspaceId: input.workspaceId,
        novelId: input.novelId,
        chapterId: input.chapterId,
        versionNo: input.versionNo,
        status: 'draft',
        contentSha256: input.contentSha256,
        contentBytes: input.contentBytes,
        contentStorageKind: input.contentStorageKind,
        contentText: input.contentText,
        contentObjectKey: input.contentObjectKey,
        summary: input.summary,
        sourceType: 'ai_generation',
        createdByUserId: this.principal.userId,
        sourceGenerationRunId: input.generationRunId,
        sourceIdempotencyKey: input.idempotencyKey,
      }).returning({ id: chapterVersions.id })
      if (version === undefined) throw new Error('chapter version draft was not created')
      return version.id
    })
  }

  /** Append context selections for a run; duplicate source selections are idempotently ignored. */
  async recordContextItems(itemsInput: readonly GenerationContextItemInput[]): Promise<void> {
    assertGenerationWorker(this.principal)
    for (const item of itemsInput) this.assertWorkspace(item.workspaceId)
    await this.withContext(async (db) => {
      for (const item of itemsInput) {
        const [existing] = await db.select({ id: generationContextItems.id }).from(generationContextItems).where(and(
          eq(generationContextItems.generationRunId, item.generationRunId),
          eq(generationContextItems.sourceType, item.sourceType),
          eq(generationContextItems.sourceId, item.sourceId),
        )).limit(1)
        if (existing !== undefined) continue
        await db.insert(generationContextItems).values(item)
      }
    })
  }

  /** Rank context candidates and persist the selected source hashes for replay. */
  async selectAndRecordContext(input: GenerationContextSelectionInput): Promise<ContextCandidate[]> {
    assertGenerationWorker(this.principal)
    this.assertWorkspace(input.workspaceId)
    return this.withContext(async (db) => {
      // One run gets one durable context set. The transaction advisory lock
      // closes the read/select/write race between multiple workers.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.novelId}:${input.generationRunId}`}, 0))`)
      const toCandidate = (item: typeof generationContextItems.$inferSelect): ContextCandidate => ({
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        workspaceId: item.workspaceId,
        novelId: item.novelId,
        status: 'published',
        relevanceScore: 0,
        recencyScore: 0,
        excerptHash: item.excerptHash,
        tokenCount: item.tokenCount,
        selectionReason: item.selectionReason,
      })
      const existing = await db.select().from(generationContextItems).where(and(
        eq(generationContextItems.workspaceId, input.workspaceId),
        eq(generationContextItems.novelId, input.novelId),
        eq(generationContextItems.generationRunId, input.generationRunId),
      )).orderBy(asc(generationContextItems.rank))
      if (existing.length > 0) return existing.map(toCandidate)
      const selected = rankContextCandidates(input.candidates, input.limit)
      const values = selected.map((candidate, rank) => {
        if (candidate.excerptHash === undefined || candidate.tokenCount === undefined) {
          throw new Error('selected context candidates require excerpt hashes and token counts')
        }
        return {
          workspaceId: input.workspaceId,
          novelId: input.novelId,
          generationRunId: input.generationRunId,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          rank,
          excerptHash: candidate.excerptHash,
          tokenCount: candidate.tokenCount,
          selectionReason: candidate.selectionReason ?? 'ranked_context',
        }
      })
      if (values.length > 0) await db.insert(generationContextItems).values(values)
      const persisted = await db.select().from(generationContextItems).where(and(
        eq(generationContextItems.workspaceId, input.workspaceId),
        eq(generationContextItems.novelId, input.novelId),
        eq(generationContextItems.generationRunId, input.generationRunId),
      )).orderBy(asc(generationContextItems.rank))
      return persisted.map(toCandidate)
    })
  }

  /** Rebuild the exact persisted context selection for a generation run. */
  async listContextItems(
    workspaceId: string,
    novelId: string,
    generationRunId: string,
  ): Promise<readonly typeof generationContextItems.$inferSelect[]> {
    this.assertWorkspace(workspaceId)
    return this.withContext(async db => db.select().from(generationContextItems).where(and(
      eq(generationContextItems.workspaceId, workspaceId),
      eq(generationContextItems.novelId, novelId),
      eq(generationContextItems.generationRunId, generationRunId),
    )).orderBy(asc(generationContextItems.rank)))
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
  }

  private withContext<T>(callback: (database: DshDatabase) => Promise<T>): Promise<T> {
    return withRequestContext(this.database, requestContext(this.principal), callback)
  }
}

export * from './generation.ts'
export * from './context-repository.ts'
export * from './result-repository.ts'
export * from './deepseek-adapter.ts'
export * from './materialization.ts'
export * from './workflow.ts'
