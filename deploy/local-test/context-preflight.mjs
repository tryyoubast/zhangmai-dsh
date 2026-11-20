/** Read-only production retrieval under the running worker's own restricted identity. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [workspaceId, novelId, generationRunId, instruction, rawLimit] = process.argv.slice(2)
assert([workspaceId, novelId, generationRunId].every(value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value ?? '')), 'Context preflight requires UUID locators')
assert(typeof instruction === 'string' && instruction.trim() !== '')
const limit = Number(rawLimit)
assert(Number.isSafeInteger(limit) && limit > 0)
assert.equal(process.env.DSH_NOVEL_DATABASE_HOST ?? 'postgres', 'postgres')

const { createDatabase } = await import('../../packages/database/database-postgres/lib/index.js')
const { PostgresGenerationWorkerIdentity, PostgresNovelContextRepository, rankContextCandidates } = await import('../../packages/storage/novel-authoring/lib/index.js')
const url = new URL('postgresql://staging_worker@postgres/dsh_staging_test')
url.password = (await readFile(`${process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets'}/worker-password`, 'utf8')).trim()
url.searchParams.set('options', '-c default_transaction_read_only=on')
const database = createDatabase({
  url: url.href, runtimeRole: 'dsh_worker_runtime', maxConnections: 1,
  idleTimeoutMs: 5_000, connectionTimeoutMs: 5_000, applicationName: 'staging-context-preflight',
})
try {
  const identity = await new PostgresGenerationWorkerIdentity(database, 'novel-worker').resolve({ workspaceId, generationRunId })
  assert(identity !== null && identity.novelId === novelId && identity.status === 'completed')
  const candidates = await new PostgresNovelContextRepository(database, identity.principal).findCandidates({ workspaceId, novelId, instruction })
  const selected = rankContextCandidates(candidates, limit)
  assert(selected.length > 0, 'Continuation context is empty')
  console.log(JSON.stringify({ context: selected.map((item, rank) => ({
    sourceType: item.sourceType, sourceId: item.sourceId, rank, excerptHash: item.excerptHash,
  })) }))
} catch {
  console.error('Worker context preflight failed; credentials and source contents are redacted.')
  process.exitCode = 1
} finally {
  await database.close()
}
