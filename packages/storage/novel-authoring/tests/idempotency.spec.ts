import { describe, expect, it } from 'vitest'
import {
  NovelAuthoringService,
  LongformAuthoringService,
  type CharacterDraftInput,
  type ChapterDraftInput,
} from '../src/index.ts'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import { generationRuns } from '@deepseek-ai/dsh-database-postgres'

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
  inserts: Array<{ table: object; values: Record<string, unknown>; conflict?: unknown }>
  selects: object[]
  nextId: number
}

function rowKey(table: object, values: Record<string, unknown>): string {
  if (table === generationRuns) return `${values.workspaceId}:${values.idempotencyKey}`
  return `${values.workspaceId}:${values.sourceIdempotencyKey}`
}

function fakeDatabase(): { database: unknown; state: FakeState } {
  const state: FakeState = { rows: new Map(), inserts: [], selects: [], nextId: 1 }
  const database = {
    db: {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => ({ rows: [] }),
        select: (projection: unknown) => {
          const builder = {
            from: (table: object) => {
              state.selects.push(table)
              const result = async () => {
                const rows = state.rows.get(table) ?? []
                return rows.slice(0, 1).map(row => ({ ...row }))
              }
              return {
                where: () => ({
                  limit: () => ({
                    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
                  }),
                }),
                then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
              }
            },
          }
          void projection
          return builder
        },
        insert: (table: object) => ({
          values: (values: Record<string, unknown>) => {
            const pending = { table, values, conflict: undefined as unknown }
            state.inserts.push(pending)
            const builder = {
              onConflictDoNothing: (config?: unknown) => {
                pending.conflict = config
                return builder
              },
              returning: () => ({
                then: (resolve: (value: unknown) => unknown) => {
                  const rows = state.rows.get(table) ?? []
                  const existing = rows.find(row => rowKey(table, row) === rowKey(table, values))
                  if (existing !== undefined) return Promise.resolve([]).then(resolve)
                  const row = { ...values, id: `generated-${state.nextId++}` }
                  rows.push(row)
                  state.rows.set(table, rows)
                  return Promise.resolve([{ id: row.id }]).then(resolve)
                },
              }),
            }
            return builder
          },
        }),
      }),
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
})
