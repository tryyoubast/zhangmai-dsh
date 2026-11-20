import { describe, expect, it } from 'vitest'
import { NovelAuthoringService, type GenerationRunInput } from '../src/index.ts'
import { editor, serviceDatabase, worker, type Row } from './coverage-fixture.ts'

const input: GenerationRunInput = {
  workspaceId: editor.workspaceId, novelId: 'novel', model: 'configured', promptVersion: 'v1',
  sourceSessionId: editor.sessionId, instruction: 'Write', contextLimit: 0, idempotencyKey: 'request-retry',
}

describe('generation request retries after worker assignment', () => {
  it.each(['queued', 'running', 'completed', 'failed'] as const)('returns the human request ID after assignment in state %s', async (status) => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, editor)
    await service.createGenerationRun(input)
    db.inserts.push([])
    db.selects.push([{ ...db.writes[0]?.values as Row, id: 'saved-run', status, agentPrincipalId: 'novel-worker' }])
    await expect(service.createGenerationRun(input)).resolves.toBe('saved-run')
    expect(db.writes.every(write => write.operation === 'insert')).toBe(true)
  })

  it.each([
    { novelId: 'other-novel' }, { model: 'other-model' }, { promptVersion: 'v2' },
    { sourceSessionId: 'other-session' }, { instruction: 'Rewrite' }, { contextLimit: 1 },
  ] satisfies Partial<GenerationRunInput>[])('rejects changed immutable input %j after assignment', async (changed) => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, editor)
    await service.createGenerationRun(input)
    db.inserts.push([])
    db.selects.push([{ ...db.writes[0]?.values as Row, id: 'saved-run', status: 'completed', agentPrincipalId: 'novel-worker' }])
    await expect(service.createGenerationRun({ ...input, ...changed })).rejects.toThrow('generation run idempotency conflict')
  })

  it('rejects another initiating user even when the request payload matches', async () => {
    const db = serviceDatabase()
    await new NovelAuthoringService(db.database, editor).createGenerationRun(input)
    db.inserts.push([])
    db.selects.push([{ ...db.writes[0]?.values as Row, id: 'saved-run', agentPrincipalId: 'novel-worker' }])
    const other = new NovelAuthoringService(db.database, { ...editor, userId: 'other-user' })
    await expect(other.createGenerationRun(input)).rejects.toThrow('initiatedByUserId mismatch')
  })

  it('keeps agent retries bound to their own worker identity', async () => {
    const db = serviceDatabase()
    const service = new NovelAuthoringService(db.database, worker)
    await service.createGenerationRun(input)
    const stored = { ...db.writes[0]?.values as Row, id: 'saved-run', status: 'running' }
    db.inserts.push([], [])
    db.selects.push([stored], [{ ...stored, agentPrincipalId: 'another-worker' }])
    await expect(service.createGenerationRun(input)).resolves.toBe('saved-run')
    await expect(service.createGenerationRun(input)).rejects.toThrow('agentPrincipalId mismatch')
  })
})
