import { describe, expect, it } from 'vitest'
import {
  NovelAuthoringService,
  LongformAuthoringService,
  type GenerationContextItemInput,
  type CharacterDraftInput,
  type ChapterDraftInput,
} from '../src/index.ts'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import { generationContextItems, generationRuns } from '@deepseek-ai/dsh-database-postgres'

const workerPrincipal: AuthPrincipal = {
  userId: 'user-1',
  sessionId: 'session-1',
  clientType: 'browser',
  workspaceId: 'workspace-1',
  roles: ['editor'],
  actorType: 'agent',
  agentPrincipalId: 'agent-1',
}

type Row = Record<string, unknown> & { id: string }

type FakeState = {
  rows: Map<object, Row[]>
  inserts: Array<{ table: object; values: Record<string, unknown> | readonly Record<string, unknown>[]; conflict?: unknown }>
  selects: Array<{ table: object; limit?: boolean }>
  nextId: number
  rollbacks: number
  insertError?: Error
}

function rowKey(table: object, values: Record<string, unknown>): string {
  if (table === generationRuns) return `${values.workspaceId}:${values.idempotencyKey}`
  if (table === generationContextItems) {
    return `${values.generationRunId}:${values.sourceType}:${values.sourceId}`
  }
  return `${values.workspaceId}:${values.sourceIdempotencyKey}`
}

function fakeDatabase(): { database: unknown; state: FakeState } {
  const state: FakeState = { rows: new Map(), inserts: [], selects: [], nextId: 1, rollbacks: 0 }
  const database = {
    db: {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
        const snapshot = new Map([...state.rows].map(([table, rows]) => [table, rows.map(row => ({ ...row }))] as const))
        const nextId = state.nextId
        try {
          return await callback({
            execute: async () => ({ rows: [] }),
            select: (projection: unknown) => {
              const builder = {
                from: (table: object) => {
                  const selection = { table, limit: false }
                  state.selects.push(selection)
                  const result = async () => {
                    const rows = state.rows.get(table) ?? []
                    const selectedRows = selection.limit === true ? rows.slice(0, 1) : rows
                    return selectedRows.map(row => ({ ...row }))
                  }
                  return {
                    where: () => ({
                      limit: () => {
                        selection.limit = true
                        return {
                          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
                        }
                      },
                      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
                    }),
                    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
                  }
                },
              }
              void projection
              return builder
            },
            insert: (table: object) => ({
              values: (values: Record<string, unknown> | readonly Record<string, unknown>[]) => {
                const pending = { table, values, conflict: undefined as unknown }
                state.inserts.push(pending)
                const builder = {
                  onConflictDoNothing: (config?: unknown) => {
                    pending.conflict = config
                    return builder
                  },
                  returning: () => ({
                    then: (resolve: (value: unknown) => unknown) => {
                      if (state.insertError !== undefined) throw state.insertError
                      const rows = state.rows.get(table) ?? []
                      const batch = Array.isArray(values) ? values : [values]
                      const inserted: Row[] = []
                      for (const value of batch) {
                        const existing = rows.find(row => rowKey(table, row) === rowKey(table, value))
                        if (existing !== undefined) continue
                        const row = { ...value, id: `generated-${state.nextId++}` }
                        rows.push(row)
                        inserted.push(row)
                      }
                      state.rows.set(table, rows)
                      if (table === generationContextItems) {
                        return Promise.resolve(inserted.map(row => ({
                          generationRunId: row.generationRunId,
                          sourceType: row.sourceType,
                          sourceId: row.sourceId,
                        }))).then(resolve)
                      }
                      return Promise.resolve(inserted.map(row => ({ id: row.id }))).then(resolve)
                    },
                  }),
                }
                return builder
              },
            }),
          })
        } catch (error) {
          state.rows = new Map([...snapshot].map(([table, rows]) => [table, rows.map(row => ({ ...row }))] as const))
          state.nextId = nextId
          state.rollbacks += 1
          throw error
        }
      },
    },
  }
  return { database, state }
}

function characterInput(overrides: Partial<CharacterDraftInput> = {}): CharacterDraftInput {
  return {
    generationRunId: 'run-1',
    workspaceId: 'workspace-1',
    novelId: 'novel-1',
    name: 'Mira',
    summary: 'A cartographer',
    attributes: { role: 'lead' },
    idempotencyKey: 'character-key',
    ...overrides,
  }
}

function chapterInput(overrides: Partial<ChapterDraftInput> = {}): ChapterDraftInput {
  return {
    generationRunId: 'run-1',
    workspaceId: 'workspace-1',
    novelId: 'novel-1',
    chapterNo: 1,
    title: 'Arrival',
    summary: 'The opening chapter',
    idempotencyKey: 'chapter-key',
    ...overrides,
  }
}

function contextItem(overrides: Partial<GenerationContextItemInput> = {}): GenerationContextItemInput {
  return {
    workspaceId: 'workspace-1',
    novelId: 'novel-1',
    generationRunId: 'run-context',
    sourceType: 'chapter_summary',
    sourceId: 'source-1',
    rank: 0,
    excerptHash: 'hash-1',
    excerpt: 'Persisted excerpt',
    sourceStatus: 'published',
    tokenCount: 3,
    selectionReason: 'ranked_context',
    ...overrides,
  }
}

describe('atomic AI idempotent writes', () => {
  it('returns a database-generated ID without a pre-insert lookup', async () => {
    const fake = fakeDatabase()
    const service = new NovelAuthoringService(fake.database as never, workerPrincipal)

    await expect(service.createGenerationRun({
      workspaceId: 'workspace-1',
      novelId: 'novel-1',
      model: 'deepseek-chat',
      promptVersion: 'v1',
      sourceSessionId: 'session-source',
      idempotencyKey: 'run-key',
    })).resolves.toBe('generated-1')

    expect(fake.state.selects).toHaveLength(0)
    expect(fake.state.inserts[0]?.conflict).toBeDefined()
  })

  it('reads back the existing character after an atomic conflict', async () => {
    const fake = fakeDatabase()
    const service = new NovelAuthoringService(fake.database as never, workerPrincipal)
    const input = characterInput()

    await expect(service.createCharacterDraft(input)).resolves.toBe('generated-1')
    await expect(service.createCharacterDraft(input)).resolves.toBe('generated-1')

    expect(fake.state.inserts).toHaveLength(2)
    expect(fake.state.selects).toHaveLength(1)
    expect(fake.state.inserts[1]?.conflict).toBeDefined()
  })

  it('rejects a chapter idempotency key reused with different content', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)

    await service.createChapterDraft(chapterInput())
    await expect(service.createChapterDraft(chapterInput({ title: 'Different title' })))
      .rejects.toThrow('chapter idempotency conflict')
  })

  it('uses a partial-index predicate for chapter idempotency conflicts', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)

    await service.createChapterDraft(chapterInput())
    const conflict = fake.state.inserts[0]?.conflict as { where?: unknown } | undefined
    expect(conflict?.where).toBeDefined()
  })

  it('writes context items in one batch and de-duplicates identical keys in memory', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)
    const first = contextItem()
    const second = contextItem({ sourceId: 'source-2', rank: 1, excerptHash: 'hash-2', excerpt: 'Second excerpt' })

    await service.recordContextItems([first, first, second])

    const contextInsert = fake.state.inserts.find(insert => insert.table === generationContextItems)
    expect(contextInsert?.values).toHaveLength(2)
    expect(fake.state.selects).toHaveLength(0)
  })

  it('reads all concurrent context conflicts back in one query', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)
    const first = contextItem()
    const second = contextItem({ sourceId: 'source-2', rank: 1, excerptHash: 'hash-2', excerpt: 'Second excerpt' })

    await service.recordContextItems([first, second])
    await service.recordContextItems([first, second])

    expect(fake.state.selects.filter(selection => selection.table === generationContextItems)).toHaveLength(1)
  })

  it('targets the context source unique constraint for the batch insert', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)

    await service.recordContextItems([contextItem()])

    const conflict = fake.state.inserts.find(insert => insert.table === generationContextItems)?.conflict as {
      target?: readonly object[]
    } | undefined
    expect(conflict?.target).toEqual([
      generationContextItems.generationRunId,
      generationContextItems.sourceType,
      generationContextItems.sourceId,
    ])
  })

  it('rolls back newly inserted context rows when a concurrent row mismatches', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)
    const existing = contextItem()
    const newItem = contextItem({ sourceId: 'source-2', rank: 1, excerptHash: 'hash-2', excerpt: 'Second excerpt' })

    await service.recordContextItems([existing])
    await expect(service.recordContextItems([newItem, contextItem({ excerpt: 'Different excerpt' })]))
      .rejects.toThrow('generation context item idempotency conflict')

    expect(fake.state.rollbacks).toBe(1)
    expect(fake.state.rows.get(generationContextItems)).toHaveLength(1)
    expect(fake.state.rows.get(generationContextItems)?.[0]?.sourceId).toBe('source-1')
  })

  it('passes through non-idempotent database errors', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)
    fake.state.insertError = new Error('foreign key violation')

    await expect(service.recordContextItems([contextItem()])).rejects.toThrow('foreign key violation')
    expect(fake.state.rollbacks).toBe(1)
  })

  it('rejects conflicting duplicate context content before inserting the batch', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)

    await expect(service.recordContextItems([contextItem(), contextItem({ excerpt: 'Different excerpt' })]))
      .rejects.toThrow('generation context item idempotency conflict')
    expect(fake.state.inserts).toHaveLength(0)
  })

  it('does not open a transaction for an empty context batch', async () => {
    const fake = fakeDatabase()
    const service = new LongformAuthoringService(fake.database as never, workerPrincipal)

    await service.recordContextItems([])

    expect(fake.state.inserts).toHaveLength(0)
    expect(fake.state.selects).toHaveLength(0)
  })
})
