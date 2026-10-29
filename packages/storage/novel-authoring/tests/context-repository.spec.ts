import { describe, expect, it } from 'vitest'
import { PostgresNovelContextRepository } from '../src/context-repository.ts'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'

const principal: AuthPrincipal = {
  userId: 'user-1',
  sessionId: 'session-1',
  clientType: 'browser',
  workspaceId: 'workspace-1',
  roles: ['editor'],
  actorType: 'user',
}

function fakeDatabase(rows: readonly Record<string, unknown>[]) {
  const queries: unknown[] = []
  type FakeTransaction = {
    execute: (query: unknown) => Promise<{ rows: readonly Record<string, unknown>[] }>
  }
  return {
    queries,
    database: {
      db: {
        transaction: async (callback: (transaction: FakeTransaction) => Promise<unknown>) => {
          let execution = 0
          return callback({
            execute: async (query: unknown) => {
              queries.push(query)
              execution += 1
              return { rows: execution === 5 ? rows : [] }
            },
          })
        },
      },
    },
  }
}

function queryText(value: unknown, seen = new Set<object>()): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  if (seen.has(value)) return ''
  seen.add(value)
  const text = Array.isArray(value)
    ? value.map(item => queryText(item, seen)).join(' ')
    : Object.values(value).map(item => queryText(item, seen)).join(' ')
  seen.delete(value)
  return text
}

describe('Postgres novel context repository', () => {
  it('filters every source branch through indexed full-text matching before ranking and keeps only matches', async () => {
    const fake = fakeDatabase([{
      source_type: 'chapter',
      source_id: 'chapter-1',
      status: 'published',
      updated_at: new Date('2026-01-01T00:00:00Z'),
      relevance_score: 1,
      excerpt: 'dragon',
    }])
    const repository = new PostgresNovelContextRepository(fake.database as never, principal)

    const candidates = await repository.findCandidates({
      workspaceId: 'workspace-1',
      novelId: 'novel-1',
      instruction: 'dragon',
    })
    const query = queryText(fake.queries[4])

    expect(candidates).toHaveLength(1)
    expect(query.match(/@@\s+plainto_tsquery\('simple'/g)).toHaveLength(14)
    expect(query).toContain("WHERE status NOT IN ('archived', 'deleted')")
    expect(query).toContain("ts_rank(to_tsvector('simple', coalesce(excerpt, ''))")
    expect(query).toContain("ORDER BY relevance_score DESC, (status = 'published') DESC, updated_at DESC")
    expect(query).toContain('LIMIT')
    expect(query).toContain('dragon')
  })

  it('returns no candidates when no source matches the instruction', async () => {
    const fake = fakeDatabase([])
    const repository = new PostgresNovelContextRepository(fake.database as never, principal)

    const candidates = await repository.findCandidates({
      workspaceId: 'workspace-1',
      novelId: 'novel-1',
      instruction: 'unmatched',
    })

    expect(candidates).toEqual([])
    expect(queryText(fake.queries[4]).match(/@@\s+plainto_tsquery\('simple'/g)).toHaveLength(14)
  })

  it('hydrates only requested source IDs without using full-text search', async () => {
    const fake = fakeDatabase([
      {
        source_type: 'outline',
        source_id: 'outline-1',
        status: 'draft',
        updated_at: new Date('2026-01-01T00:00:00Z'),
        relevance_score: 0,
        excerpt: 'outline',
      },
      {
        source_type: 'chapter_summary',
        source_id: 'summary-1',
        status: 'published',
        updated_at: new Date('2026-01-02T00:00:00Z'),
        relevance_score: 0,
        excerpt: 'summary',
      },
    ])
    const repository = new PostgresNovelContextRepository(fake.database as never, principal)

    const candidates = await repository.hydrateContext({
      workspaceId: 'workspace-1',
      novelId: 'novel-1',
      items: [
        {
          workspaceId: 'workspace-1',
          novelId: 'novel-1',
          generationRunId: 'run-1',
          sourceType: 'outline',
          sourceId: 'outline-1',
          rank: 0,
          excerptHash: 'hash-1',
          excerpt: 'outline',
          sourceStatus: 'draft',
          tokenCount: 1,
          selectionReason: 'test',
        },
        {
          workspaceId: 'workspace-1',
          novelId: 'novel-1',
          generationRunId: 'run-1',
          sourceType: 'chapter_summary',
          sourceId: 'summary-1',
          rank: 1,
          excerptHash: 'hash-2',
          excerpt: 'summary',
          sourceStatus: 'published',
          tokenCount: 1,
          selectionReason: 'test',
        },
        {
          workspaceId: 'workspace-1',
          novelId: 'novel-1',
          generationRunId: 'run-1',
          sourceType: 'outline',
          sourceId: 'outline-1',
          rank: 2,
          excerptHash: 'hash-3',
          excerpt: 'outline',
          sourceStatus: 'draft',
          tokenCount: 1,
          selectionReason: 'test',
        },
      ],
    })
    const query = queryText(fake.queries[4])

    expect(candidates.map(candidate => candidate.sourceId)).toEqual(['outline-1', 'summary-1'])
    expect(query).toContain('requested')
    expect(query).not.toContain('@@ plainto_tsquery')
    expect(query).toContain('outline-1')
    expect(query).toContain('summary-1')
    expect(query).toContain('SELECT DISTINCT source_type, source_id')
  })
})
