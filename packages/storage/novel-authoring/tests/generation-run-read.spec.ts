import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient, type DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import { NovelAuthoringService } from '../src/index.ts'
import { editor } from './coverage-fixture.ts'

const databases: DatabaseClient<DshDatabase>[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.close()))
})

function databaseReader(runRows: unknown[][] = [['run', 'completed']], proposalRows: unknown[][] = [['proposal', 'characters', 'character', 'draft']]) {
  const database = createDatabase({
    url: 'postgresql://reader:unused@127.0.0.1:5432/unused', maxConnections: 1,
    idleTimeoutMs: 1000, connectionTimeoutMs: 1000, applicationName: 'generation-read-test', runtimeRole: 'dsh_app_runtime',
  })
  databases.push(database)
  const queries: Array<{ text: string; values: readonly unknown[] }> = []
  const query = vi.fn(async (input: string | { readonly text: string }, values?: unknown[]) => {
    const text = typeof input === 'string' ? input : input.text
    queries.push({ text, values: values ?? [] })
    return { rows: text.includes('from "ai"."generation_runs"') ? runRows
      : text.includes('from "ai"."generation_proposals"') ? proposalRows : [] }
  })
  vi.spyOn(database.pool, 'connect').mockResolvedValue({ query, release: vi.fn() })
  return { service: new NovelAuthoringService(database, editor), queries }
}

const locator = { workspaceId: 'workspace', novelId: 'novel', generationRunId: 'run' }

describe('generation run safe read model', () => {
  it('reads only run state and proposal locators with workspace, novel, and run predicates in an RLS transaction', async () => {
    const { service, queries } = databaseReader()
    await expect(service.getGenerationRun(locator)).resolves.toEqual({
      runId: 'run', status: 'completed',
      proposals: [{ id: 'proposal', targetType: 'characters', targetId: 'character', status: 'draft' }],
    })
    const runQuery = queries.find(query => query.text.includes('from "ai"."generation_runs"'))
    const proposalQuery = queries.find(query => query.text.includes('from "ai"."generation_proposals"'))
    for (const query of [runQuery, proposalQuery]) {
      expect(query?.values.slice(0, 3)).toEqual(['workspace', 'novel', 'run'])
      expect(query?.text).toContain('"workspace_id" = $1')
      expect(query?.text).toContain('"novel_id" = $2')
      expect(query?.text).not.toMatch(/instruction|error_summary|error_code|proposed_content|validation_result/)
    }
    expect(runQuery?.text).toContain('"id" = $3')
    expect(proposalQuery?.text).toContain('"generation_run_id" = $3')
    expect(queries.some(query => query.values.includes('app.workspace_id') && query.values.includes('workspace'))).toBe(true)
    expect(queries.at(-1)?.text).toBe('commit')
  })

  it('returns undefined for a nonexistent or RLS-invisible run without querying its proposals', async () => {
    const { service, queries } = databaseReader([])
    await expect(service.getGenerationRun(locator)).resolves.toBeUndefined()
    expect(queries.some(query => query.text.includes('generation_proposals'))).toBe(false)
  })

  it('returns an empty proposal list for a queued run', async () => {
    const { service } = databaseReader([['run', 'queued']], [])
    await expect(service.getGenerationRun(locator)).resolves.toEqual({ runId: 'run', status: 'queued', proposals: [] })
  })

  it('rejects another workspace before opening a database transaction', async () => {
    const { service, queries } = databaseReader()
    await expect(service.getGenerationRun({ ...locator, workspaceId: 'foreign' })).rejects.toThrow('workspace context mismatch')
    expect(queries).toEqual([])
  })
})
