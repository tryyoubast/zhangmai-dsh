import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient, type DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import { NovelAuthoringService } from '../src/index.ts'
import { worker } from './coverage-fixture.ts'

const databases: DatabaseClient<DshDatabase>[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.close()))
})

describe('queued claim transaction statements', () => {
  it('locks the candidate and starts the claimed run before committing the same RLS transaction', async () => {
    const database = createDatabase({
      url: 'postgresql://worker:unused@127.0.0.1:5432/unused', runtimeRole: 'dsh_worker_runtime', maxConnections: 1,
      idleTimeoutMs: 1_000, connectionTimeoutMs: 1_000, applicationName: 'queued-claim-statements',
    })
    databases.push(database)
    const row: Record<string, unknown> = {
      id: 'run', workspace_id: 'workspace', novel_id: 'novel', status: 'queued',
      model: 'configured', prompt_version: 'v1', source_session_id: 'session',
      idempotency_key: 'retry', instruction: 'Saved instruction', context_limit: 0,
    }
    const queries: Array<{ text: string; values: readonly unknown[] }> = []
    const query = vi.fn(async (input: string | { readonly text: string }, values?: unknown[]) => {
      const text = typeof input === 'string' ? input : input.text
      queries.push({ text, values: values ?? [] })
      if (text.includes('ai.claim_generation_run')) return { rows: [{ claimed: true }] }
      if (text.includes('from "ai"."generation_runs"')) {
        const fields = text.slice('select '.length, text.indexOf(' from ')).split(',')
        return { rows: [fields.map(field => row[field.trim().replaceAll('"', '')])] }
      }
      return { rows: [] }
    })
    const connect = vi.spyOn(database.pool, 'connect').mockResolvedValue({ query, release: vi.fn() })
    const request = await new NovelAuthoringService(database, worker).getQueuedGenerationRequest({ workspaceId: 'workspace', generationRunId: 'run' })
    expect(request).toMatchObject({ generationRunId: 'run', instruction: 'Saved instruction', contextLimit: 0 })
    const candidateIndex = queries.findIndex(query => query.text.includes('from "ai"."generation_runs"'))
    const claimIndex = queries.findIndex(query => query.text.includes('ai.claim_generation_run'))
    const runningIndex = queries.findIndex(query => query.text.startsWith('update "ai"."generation_runs"'))
    expect(queries[candidateIndex]?.text).toMatch(/for update$/)
    expect(queries[candidateIndex]?.values.slice(0, 2)).toEqual(['workspace', 'run'])
    expect(claimIndex).toBeGreaterThan(candidateIndex)
    expect(runningIndex).toBeGreaterThan(claimIndex)
    expect(queries[runningIndex]?.values).toContain('running')
    expect(queries.at(-1)?.text).toBe('commit')
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
