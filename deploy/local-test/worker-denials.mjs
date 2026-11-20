/** Attempt forbidden publication operations using only the running worker's restricted credential. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [workspaceId, generationRunId, proposalId, targetId] = process.argv.slice(2)
if (![workspaceId, generationRunId, proposalId, targetId].every(value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value ?? ''))) {
  console.error('Worker denial verification requires four UUID locators')
  process.exit(1)
}
if ((process.env.DSH_NOVEL_DATABASE_HOST ?? 'postgres') !== 'postgres') {
  throw new Error('Worker denial verification requires the isolated postgres service')
}

const { createDatabase, sql, withRequestContext } = await import('../../packages/database/database-postgres/lib/index.js')
const { PostgresGenerationWorkerIdentity } = await import('../../packages/storage/novel-authoring/lib/index.js')
const url = new URL('postgresql://staging_worker@postgres/dsh_staging_test')
url.password = (await readFile(`${process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets'}/worker-password`, 'utf8')).trim()
const database = createDatabase({
  url: url.href, runtimeRole: 'dsh_worker_runtime', maxConnections: 1,
  idleTimeoutMs: 5_000, connectionTimeoutMs: 5_000, applicationName: 'staging-worker-denials',
})

function denied(error) {
  return error?.code === '42501' || error?.cause?.code === '42501'
}

try {
  const identity = await new PostgresGenerationWorkerIdentity(database, 'novel-worker').resolve({ workspaceId, generationRunId })
  assert(identity !== null)
  const context = { userId: identity.principal.userId, workspaceId, actorType: 'agent', agentPrincipalId: 'novel-worker' }
  const visible = await withRequestContext(database, context, db => db.execute(sql`
    SELECT id,status FROM ai.generation_proposals
    WHERE workspace_id=${workspaceId}::uuid AND generation_run_id=${generationRunId}::uuid AND id=${proposalId}::uuid
  `))
  assert.equal(visible.rows.length, 1)
  assert.equal(visible.rows[0].status, 'draft')
  const operations = {
    review: sql`UPDATE ai.generation_proposals SET status='approved',reviewed_by_user_id=${context.userId}::uuid,reviewed_at=now()
      WHERE workspace_id=${workspaceId}::uuid AND id=${proposalId}::uuid`,
    publish: sql`SELECT ai.publish_generation_proposal(${workspaceId}::uuid,${proposalId}::uuid)`,
    rollback: sql`SELECT ai.rollback_entity_version(${workspaceId}::uuid,'characters',${targetId}::uuid,1)`,
  }
  const result = {}
  for (const [name, statement] of Object.entries(operations)) {
    try {
      await withRequestContext(database, context, async db => {
        await db.execute(statement)
        // An unexpected grant must also roll back; acceptance never commits its forbidden attempts.
        throw new Error('Worker operation unexpectedly allowed')
      })
    } catch (error) {
      if (!denied(error)) throw error
      result[name] = true
    }
  }
  assert.equal(Object.keys(result).length, 3)
  console.log(JSON.stringify(result))
} catch {
  console.error('Worker denial verification failed; credentials and fixture contents are redacted.')
  process.exitCode = 1
} finally {
  await database.close()
}
