import { createHash } from 'node:crypto'
import { sql, withRequestContext, type DatabaseClient, type DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import type {
  ContextCandidate,
} from './index.ts'
import type {
  ContextCandidateQuery,
  PersistedContextCandidateRepository,
  PersistedGenerationContextItem,
} from './generation.ts'

const MAX_EXCERPT_BYTES = 16_384
const MAX_CANDIDATES = 500

type ContextRow = {
  source_type: string
  source_id: string
  status: string
  updated_at: Date
  relevance_score: number
  excerpt: string
}

function excerptHash(excerpt: string): string {
  return createHash('sha256').update(excerpt, 'utf8').digest('hex')
}

function tokenCount(excerpt: string): number {
  // This is deliberately conservative metadata, not a provider tokenizer.
  return Math.max(1, Math.ceil(excerpt.length / 4))
}

function candidate(row: ContextRow, workspaceId: string, novelId: string): ContextCandidate {
  const excerpt = Buffer.from(row.excerpt, 'utf8').subarray(0, MAX_EXCERPT_BYTES).toString('utf8')
  return {
    workspaceId,
    novelId,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status === 'published' ? 'published' : 'draft',
    relevanceScore: row.relevance_score,
    recencyScore: row.updated_at.getTime(),
    excerptHash: excerptHash(excerpt),
    tokenCount: tokenCount(excerpt),
    selectionReason: 'workspace_novel_context',
    excerpt,
  }
}

/**
 * PostgreSQL-backed context retrieval. All source rows are selected through
 * the authenticated transaction so RLS remains the final tenant boundary.
 */
export class PostgresNovelContextRepository implements PersistedContextCandidateRepository {
  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly principal: AuthPrincipal,
  ) {}

  async findCandidates(query: ContextCandidateQuery): Promise<readonly ContextCandidate[]> {
    this.assertScope(query.workspaceId, query.novelId)
    return withRequestContext(this.database, this.context(), async (db) => {
      const result = await db.execute(sql`
        WITH sources AS (
          SELECT 'outline'::text AS source_type, id AS source_id, status, updated_at,
            left(title || E'\\n' || content_jsonb::text, 16384) AS excerpt
            FROM novel.outlines
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'chapter'::text, id, status, updated_at,
            left(title || E'\\n' || coalesce(summary, ''), 16384)
            FROM novel.chapters
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'chapter_summary'::text, id, status, updated_at,
            left(content_text, 16384)
            FROM novel.chapter_summaries
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'story_fact'::text, id, status, updated_at,
            left(fact_key || E'\\n' || statement || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.story_facts
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'timeline_event'::text, id, status, updated_at,
            left(title || E'\\n' || coalesce(description, '') || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.timeline_events
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'character'::text, id, status, updated_at,
            left(name || E'\\n' || coalesce(summary, '') || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.characters
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'skill'::text, id, status, updated_at,
            left(name || E'\\n' || coalesce(summary, '') || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.skills
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'location'::text, id, status, updated_at,
            left(name || E'\\n' || coalesce(summary, '') || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.locations
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'faction'::text, id, status, updated_at,
            left(name || E'\\n' || coalesce(summary, '') || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.factions
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'item'::text, id, status, updated_at,
            left(name || E'\\n' || coalesce(summary, '') || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.items
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'storyline'::text, id, status, updated_at,
            left(name || E'\\n' || coalesce(summary, '') || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.storylines
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'chapter_version'::text, id, status, created_at,
            left(coalesce(summary, '') || E'\\n' || coalesce(content_text, content_object_key, ''), 16384)
            FROM novel.chapter_versions
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
          UNION ALL
          SELECT 'entity_relation'::text, id, status, updated_at,
            left(source_entity_type || ':' || source_entity_id::text || ' ' || relation_type || ' ' || target_entity_type || ':' || target_entity_id::text || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.entity_relations
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
              AND deleted_at IS NULL
          UNION ALL
          SELECT 'character_skill'::text, id, status, created_at,
            left(relation_type || E'\\n' || attributes_jsonb::text, 16384)
            FROM novel.character_skills
            WHERE workspace_id = ${query.workspaceId}::uuid AND novel_id = ${query.novelId}::uuid
        )
        SELECT source_type, source_id::text, status, updated_at,
          ts_rank(to_tsvector('simple', coalesce(excerpt, '')), plainto_tsquery('simple', ${query.instruction})) AS relevance_score,
          excerpt
        FROM sources
        WHERE status NOT IN ('archived', 'deleted')
        ORDER BY relevance_score DESC, (status = 'published') DESC, updated_at DESC
        LIMIT ${MAX_CANDIDATES}
      `)
      return (result.rows as unknown as ContextRow[]).map(row => candidate(row, query.workspaceId, query.novelId))
    })
  }

  async hydrateContext(input: {
    readonly workspaceId: string
    readonly novelId: string
    readonly items: readonly PersistedGenerationContextItem[]
  }): Promise<readonly ContextCandidate[]> {
    const candidates = await this.findCandidates({
      workspaceId: input.workspaceId,
      novelId: input.novelId,
      instruction: '',
    })
    const requested = new Set(input.items.map(item => `${item.sourceType}\u0000${item.sourceId}`))
    return candidates.filter(item => requested.has(`${item.sourceType}\u0000${item.sourceId}`))
  }

  private assertScope(workspaceId: string, novelId: string): void {
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    if (this.principal.actorType === 'agent' && this.principal.agentPrincipalId === undefined) {
      throw new Error('agent context requires an agent principal')
    }
    if (workspaceId.trim() === '' || novelId.trim() === '') throw new Error('workspace and novel are required')
  }

  private context(): {
    userId: string
    workspaceId: string
    actorType: 'user' | 'agent'
    agentPrincipalId?: string
  } {
    return {
      userId: this.principal.userId,
      workspaceId: this.principal.workspaceId,
      actorType: this.principal.actorType,
      ...(this.principal.agentPrincipalId === undefined ? {} : { agentPrincipalId: this.principal.agentPrincipalId }),
    }
  }
}
