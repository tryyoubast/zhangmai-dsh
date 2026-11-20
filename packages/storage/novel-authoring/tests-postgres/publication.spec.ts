import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateDatabase } from '@deepseek-ai/dsh-database-postgres'
import { postgresTestEnvironment } from '../../../identity/user-auth/tests-postgres/environment.ts'
import { TestPgClient } from '../../../identity/user-auth/tests-postgres/pg-client.ts'

const config = postgresTestEnvironment()
const control = new TestPgClient({ connectionString: config.migrationUrl })
const runtime = new TestPgClient({ connectionString: config.runtimeUrl })
const serviceConfig = postgresTestEnvironment({ ...process.env, DATABASE_TEST_URL: process.env.DATABASE_SERVICE_TEST_URL })
const workerConfig = postgresTestEnvironment({ ...process.env, DATABASE_TEST_URL: process.env.DATABASE_WORKER_TEST_URL })
const service = new TestPgClient({ connectionString: serviceConfig.runtimeUrl })
const service2 = new TestPgClient({ connectionString: serviceConfig.runtimeUrl })
const worker = new TestPgClient({ connectionString: workerConfig.runtimeUrl })
const entities = [
  ['characters', 'character_versions', 'character_id'], ['skills', 'skill_versions', 'skill_id'],
  ['locations', 'location_versions', 'location_id'], ['factions', 'faction_versions', 'faction_id'],
  ['items', 'item_versions', 'item_id'], ['storylines', 'storyline_versions', 'storyline_id'],
  ['entity_relations', 'entity_relation_versions', 'relation_id'], ['character_skills', 'character_skill_versions', 'character_skill_id'],
] as const

beforeAll(async () => {
  if (process.env.DSH_PUBLICATION_BASELINE !== '1') {
    try { await migrateDatabase(config.migrationUrl) } catch (error) {
      const detail = error as { position?: string; internalPosition?: string; internalQuery?: string; where?: string }
      console.error('Migration diagnostics', detail.position, detail.internalPosition, detail.internalQuery, detail.where)
      throw error
    }
  }
  for (const [client, role] of [[control, 'dsh_migrator'], [runtime, 'dsh_app_runtime'], [service, 'dsh_service_runtime'], [service2, 'dsh_service_runtime'], [worker, 'dsh_worker_runtime']] as const) {
    await client.connect()
    const result = await client.query(`SELECT rolsuper,rolbypassrls,
      ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname<>session_user AND pg_has_role(session_user,oid,'MEMBER')) AS memberships
      FROM pg_roles WHERE rolname=session_user`)
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, memberships: [role] })
    await client.query(`SET ROLE ${role}`)
    await client.query("SET statement_timeout='15s'")
  }
})
afterAll(async () => { await Promise.all([control.end(), runtime.end(), service.end(), service2.end(), worker.end()]) })

async function seed() {
  const user = randomUUID(), session = randomUUID(), workspace = randomUUID(), novel = randomUUID(), run = randomUUID()
  await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at,email_verified_at)
    VALUES($1,$2,$2,'fixture','active',now(),now())`, [user, `${user}@test.invalid`])
  await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
    VALUES($1,$2,$3,'web',now()+interval '1 day',now())`, [session, user, randomUUID()])
  await control.query("INSERT INTO app.workspaces(id,owner_user_id,name,status) VALUES($1,$2,'Publication fixture','active')", [workspace, user])
  await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace, user])
  await control.query("INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id) VALUES($1,$2,'Publication fixture','draft',$3)", [novel, workspace, user])
  await control.query(`INSERT INTO ai.generation_runs(id,workspace_id,novel_id,initiated_by_user_id,agent_principal_id,model,prompt_version,source_session_id,status,idempotency_key,instruction,context_limit)
    VALUES($1,$2,$3,$4,'user-request','fixture','v1',$5,'queued',$6,'Fixture',0)`, [run, workspace, novel, user, session, randomUUID()])
  return { user, workspace, novel, run }
}
type Fixture = Awaited<ReturnType<typeof seed>>
async function context<T>(client: TestPgClient, fixture: Fixture, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  try {
    await client.query('SELECT set_config(\'app.user_id\',$1,true),set_config(\'app.workspace_id\',$2,true),set_config(\'app.actor_type\',\'user\',true)', [fixture.user, fixture.workspace])
    const result = await work()
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
}
async function target(f: Fixture, table: string) {
  const id = randomUUID()
  if (table === 'character_skills' || table === 'entity_relations') {
    const character = await target(f, 'characters'), skill = await target(f, 'skills')
    if (table === 'character_skills') await control.query(`INSERT INTO novel.character_skills(id,workspace_id,novel_id,character_id,skill_id,relation_type,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'trained',$6)`, [id, f.workspace, f.novel, character, skill, f.user])
    else await control.query(`INSERT INTO novel.entity_relations(id,workspace_id,novel_id,source_entity_type,source_entity_id,target_entity_type,target_entity_id,relation_type,created_by_user_id)
      VALUES($1,$2,$3,'characters',$4,'skills',$5,'trained',$6)`, [id, f.workspace, f.novel, character, skill, f.user])
  } else await control.query(`INSERT INTO novel.${table}(id,workspace_id,novel_id,name,created_by_user_id) VALUES($1,$2,$3,'Original',$4)`, [id, f.workspace, f.novel, f.user])
  return id
}
async function payload(table: string, id: string) {
  const rows = await control.query(`SELECT to_jsonb(t)-ARRAY['id','workspace_id','novel_id','status','current_version_no','created_by_user_id','source_generation_run_id','source_idempotency_key','created_at','updated_at','deleted_at'] AS content FROM novel.${table} t WHERE id=$1`, [id])
  return rows.rows[0]!.content as Record<string, unknown>
}
async function proposal(f: Fixture, table: string, id: string, content: Record<string, unknown>, base?: number) {
  const proposalId = randomUUID()
  await control.query(`INSERT INTO ai.generation_proposals(id,workspace_id,novel_id,generation_run_id,target_type,target_id,operation,base_version_no,proposed_content,idempotency_key,validation_result,conflict_result,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}','{}','draft')`, [proposalId, f.workspace, f.novel, f.run, table, id, base ? 'update' : table === 'character_skills' ? 'link' : 'create', base ?? null, content, randomUUID()])
  return proposalId
}
async function approve(f: Fixture, id: string) {
  await context(runtime, f, () => runtime.query("UPDATE ai.generation_proposals SET status='approved',reviewed_by_user_id=$2,reviewed_at=statement_timestamp() WHERE id=$1", [id, f.user]))
}
async function publish(f: Fixture, id: string) {
  return context(service, f, () => service.query('SELECT * FROM ai.publish_generation_proposal($1,$2)', [f.workspace, id]))
}

async function workerContext<T>(f: Fixture, work: () => Promise<T>): Promise<T> {
  return context(worker, f, async () => {
    await worker.query("SELECT set_config('app.actor_type','agent',true),set_config('app.agent_principal_id','novel-worker',true)")
    return work()
  })
}

async function longformTarget(f: Fixture, table: string): Promise<string> {
  const id = randomUUID()
  const common = { id, workspace_id: f.workspace, novel_id: f.novel, created_by_user_id: f.user }
  let data: Record<string, unknown>
  switch (table) {
    case 'outlines': data = { ...common, title: 'Outline', content_jsonb: {} }; break
    case 'chapters': data = { ...common, chapter_no: 1, title: 'Chapter', summary: null }; break
    case 'chapter_versions': data = { ...common, chapter_id: await longformTarget(f, 'chapters'), version_no: 1,
      content_sha256: 'a'.repeat(64), content_bytes: 4, content_storage_kind: 'postgres_text', content_text: 'Text', source_type: 'manual' }; break
    case 'chapter_summaries': {
      const version = await longformTarget(f, 'chapter_versions')
      const row = await control.query('SELECT chapter_id FROM novel.chapter_versions WHERE id=$1', [version])
      data = { ...common, chapter_id: row.rows[0]!.chapter_id, chapter_version_id: version, summary_kind: 'short', content_text: 'Summary', content_sha256: 'a'.repeat(64) }; break
    }
    case 'story_facts': data = { ...common, fact_key: randomUUID(), statement: 'Fact' }; break
    case 'timeline_events': data = { ...common, event_key: randomUUID(), title: 'Event', description: null, sequence_no: null }; break
    default: throw new Error('Unsupported fixture table')
  }
  const columns = Object.keys(data)
  await control.query(`INSERT INTO novel.${table}(${columns.join(',')},status) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')},'draft')`, Object.values(data))
  return id
}

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function blockedBy(pid: unknown, blockingPid: unknown) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await control.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [pid, blockingPid])
    if (result.rows[0]?.blocked) return
  }
  throw new Error('Expected PostgreSQL lock wait was not observed')
}

async function publishStatement(client: TestPgClient, f: Fixture, p: string) {
  return client.query('SELECT * FROM ai.publish_generation_proposal($1,$2)', [f.workspace, p])
}

async function publishedPair() {
  const f = await seed(), id = await target(f, 'characters'), initial = await payload('characters', id)
  const first = await proposal(f, 'characters', id, initial)
  await approve(f, first); await publish(f, first)
  const second = await proposal(f, 'characters', id, { ...initial, name: 'Second' }, 1)
  await approve(f, second); await publish(f, second)
  return { f, id, initial }
}

async function approvedThirdCharacterVersion() {
  const { f, id, initial } = await publishedPair()
  await control.query("UPDATE ai.generation_runs SET agent_principal_id='novel-worker' WHERE id=$1", [f.run])
  const p = await proposal(f, 'characters', id, { ...initial, name: 'Third' }, 2)
  await approve(f, p)
  return { f, id, initial, p }
}

async function insertWorkerCandidate(f: Fixture, candidate: string, id: string, content: Record<string, unknown>) {
  await worker.query(`INSERT INTO ai.generation_proposals(id,workspace_id,novel_id,generation_run_id,target_type,target_id,operation,base_version_no,proposed_content,validation_result,status,idempotency_key)
    VALUES($1,$2,$3,$4,'characters',$5,'update',2,$6,'{}','draft',$7)`, [candidate, f.workspace, f.novel, f.run, id, content, randomUUID()])
}

async function expectStaleCandidate(f: Fixture, candidate: string) {
  expect((await control.query('SELECT status,version_no FROM novel.character_versions WHERE source_id=$1', [candidate])).rows).toEqual([{ status: 'draft', version_no: 3 }])
  await approve(f, candidate)
  await expect(publish(f, candidate)).rejects.toMatchObject({ code: 'P2003' })
}

describe('independent proposal candidates using restricted PostgreSQL roles', () => {
  it.each(entities)('%s publishes create/update and appends a complete rollback snapshot', async (table, versions, parent) => {
    const f = await seed(), id = await target(f, table), initial = await payload(table, id)
    const first = await proposal(f, table, id, initial)
    const candidates = await control.query(`SELECT source_id,source_type,version_no,status,content_jsonb FROM novel.${versions} WHERE ${parent}=$1`, [id])
    expect(candidates.rows).toEqual([{ source_id: first, source_type: 'generation_proposal', version_no: 1, status: 'draft', content_jsonb: initial }])
    await approve(f, first)
    await publish(f, first)
    const changed = { ...initial, attributes_jsonb: {}, attributes_schema_version: 2, ...(table === 'entity_relations' ? { strength: 7, source_version_no: 4 } : table === 'character_skills' ? { source_version_no: 4 } : { name: 'Revised', summary: null }) }
    const second = await proposal(f, table, id, changed, 1)
    const loser = await proposal(f, table, id, changed, 1)
    await approve(f, second); await approve(f, loser)
    await publish(f, second)
    await expect(publish(f, loser)).rejects.toMatchObject({ code: 'P2003' })
    await context(service, f, () => service.query('SELECT ai.rollback_entity_version($1,$2,$3,1)', [f.workspace, table, id]))
    expect(await payload(table, id)).toEqual(initial)
    const history = await control.query(`SELECT version_no,status,source_type FROM novel.${versions} WHERE ${parent}=$1 ORDER BY version_no,status`, [id])
    expect(history.rows).toHaveLength(4)
    expect(history.rows.filter(row => row.status === 'published').map(row => row.version_no)).toEqual([1, 2, 3])
    const audit = await control.query('SELECT action,count(*)::int AS count FROM security.audit_events WHERE target_id=$1 AND action IN (\'ai_proposal_published\',\'novel_entity_rolled_back\') GROUP BY action ORDER BY action', [id])
    expect(audit.rows).toEqual([{ action: 'ai_proposal_published', count: 2 }, { action: 'novel_entity_rolled_back', count: 1 }])
  })

  it('keeps missing and foreign proposals indistinguishable', async () => {
    const f = await seed(), foreign = await seed(), id = await target(foreign, 'characters')
    const p = await proposal(foreign, 'characters', id, await payload('characters', id))
    for (const absent of [randomUUID(), p]) await expect(publish(f, absent)).rejects.toMatchObject({ code: 'P2001' })
  })

  it('synchronizes only its own draft content, reuses rejected candidates, and refuses expired reopening', async () => {
    const f = await seed(), id = await target(f, 'characters'), content = await payload('characters', id)
    const p = await proposal(f, 'characters', id, content)
    const before = await control.query("SELECT id FROM novel.character_versions WHERE source_id=$1 AND source_type='generation_proposal'", [p])
    const changed = { ...content, name: 'Edited proposal' }
    await context(runtime, f, () => runtime.query('UPDATE ai.generation_proposals SET proposed_content=$2 WHERE id=$1', [p, changed]))
    const candidate = await control.query('SELECT id,content_jsonb FROM novel.character_versions WHERE source_id=$1', [p])
    expect(candidate.rows).toEqual([{ id: before.rows[0]!.id, content_jsonb: changed }])
    await expect(context(runtime, f, () => runtime.query("UPDATE novel.character_versions SET content_jsonb=content_jsonb||'{\"name\":\"Forged\"}' WHERE source_id=$1", [p]))).rejects.toMatchObject({ code: '42501' })
    await context(runtime, f, () => runtime.query("UPDATE ai.generation_proposals SET status='rejected',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1", [p, f.user]))
    await expect(context(runtime, f, () => runtime.query('UPDATE ai.generation_proposals SET proposed_content=$2 WHERE id=$1', [p, content]))).rejects.toThrow()
    await context(runtime, f, () => runtime.query("UPDATE ai.generation_proposals SET status='draft',reviewed_by_user_id=NULL,reviewed_at=NULL WHERE id=$1", [p]))
    expect((await control.query('SELECT id FROM novel.character_versions WHERE source_id=$1', [p])).rows).toEqual(before.rows)
    await context(runtime, f, () => runtime.query("UPDATE ai.generation_proposals SET status='expired',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1", [p, f.user]))
    await expect(context(runtime, f, () => runtime.query("UPDATE ai.generation_proposals SET status='draft',reviewed_by_user_id=NULL,reviewed_at=NULL WHERE id=$1", [p]))).rejects.toThrow()
  })

  it('binds a legacy unbound create atomically and preserves its original identity', async () => {
    const f = await seed(), id = await target(f, 'characters'), content = await payload('characters', id)
    const p = randomUUID()
    await control.query(`INSERT INTO ai.generation_proposals(id,workspace_id,novel_id,generation_run_id,target_type,operation,proposed_content,validation_result,status,idempotency_key)
      VALUES($1,$2,$3,$4,'characters','create',$5,'{}','draft',$6)`, [p, f.workspace, f.novel, f.run, content, randomUUID()])
    expect((await control.query('SELECT id FROM novel.character_versions WHERE source_id=$1', [p])).rows).toHaveLength(0)
    await context(runtime, f, () => runtime.query('UPDATE ai.generation_proposals SET target_id=$2 WHERE id=$1', [p, id]))
    expect((await control.query('SELECT id FROM novel.character_versions WHERE source_id=$1', [p])).rows).toHaveLength(1)
    const other = await target(f, 'characters')
    await expect(context(runtime, f, () => runtime.query('UPDATE ai.generation_proposals SET target_id=$2 WHERE id=$1', [p, other]))).rejects.toThrow()
  })

  it('rejects forged candidate sources, direct service inserts, and publication from an app role', async () => {
    const f = await seed(), id = await target(f, 'characters'), content = await payload('characters', id)
    const p = await proposal(f, 'characters', id, content)
    for (const [sourceId, sourceType] of [[null, 'generation_proposal'], [p, 'generation_proposal'], [randomUUID(), 'generation_proposal']] as const) {
      await expect(context(runtime, f, () => runtime.query(`INSERT INTO novel.character_versions(workspace_id,novel_id,character_id,version_no,status,content_jsonb,source_type,source_id,source_generation_run_id,source_idempotency_key,created_by_user_id)
        VALUES($1,$2,$3,1,'draft',$4,$5,$6,$7,$8,$9)`, [f.workspace, f.novel, id, content, sourceType, sourceId, f.run, randomUUID(), f.user]))).rejects.toThrow()
    }
    await expect(context(service, f, () => service.query(`INSERT INTO novel.character_versions(workspace_id,novel_id,character_id,version_no,status,content_jsonb,source_type,created_by_user_id)
      VALUES($1,$2,$3,1,'draft',$4,'manual',$5)`, [f.workspace, f.novel, id, content, f.user]))).rejects.toMatchObject({ code: '42501' })
    await expect(context(runtime, f, () => runtime.query('SELECT * FROM ai.publish_generation_proposal($1,$2)', [f.workspace, p]))).rejects.toMatchObject({ code: '42501' })
  })

  it.each(['characters', 'outlines'] as const)('rejects service-side %s proposal publication unless its target and candidate are already published', async (type) => {
    const f = await seed()
    const id = type === 'outlines' ? await longformTarget(f, type) : await target(f, type)
    const content = await payload(type, id)
    const p = await proposal(f, type, id, content)
    await approve(f, p)
    await expect(context(service, f, () => service.query(
      "UPDATE ai.generation_proposals SET status='published',published_at=statement_timestamp() WHERE id=$1", [p],
    ))).rejects.toMatchObject({ code: '42501' })
    expect((await control.query('SELECT status,published_at FROM ai.generation_proposals WHERE id=$1', [p])).rows)
      .toEqual([{ status: 'approved', published_at: null }])
    expect((await control.query("SELECT count(*)::int AS count FROM security.audit_events WHERE target_id=$1 AND action='ai_proposal_published'", [id])).rows)
      .toEqual([{ count: 0 }])
  })

  it('rolls back the complete publication when its audit insert fails', async () => {
    const f = await seed(), id = await target(f, 'characters'), content = await payload('characters', id)
    const p = await proposal(f, 'characters', id, content)
    await approve(f, p)
    const constraint = `publication_audit_${randomUUID().replaceAll('-', '')}`
    await control.query(`ALTER TABLE security.audit_events ADD CONSTRAINT ${constraint} CHECK (target_id IS DISTINCT FROM '${id}' OR action<>'ai_proposal_published') NOT VALID`)
    try {
      await expect(publish(f, p)).rejects.toMatchObject({ code: '23514' })
      expect((await control.query('SELECT status FROM ai.generation_proposals WHERE id=$1', [p])).rows).toEqual([{ status: 'approved' }])
      expect((await control.query('SELECT status FROM novel.character_versions WHERE source_id=$1', [p])).rows).toEqual([{ status: 'draft' }])
      expect((await control.query('SELECT status,current_version_no FROM novel.characters WHERE id=$1', [id])).rows).toEqual([{ status: 'draft', current_version_no: 1 }])
    } finally { await control.query(`ALTER TABLE security.audit_events DROP CONSTRAINT ${constraint}`) }
  })

  it('rolls back the complete entity rollback when its audit insert fails and clears transaction settings', async () => {
    const { f, id } = await publishedPair()
    const before = await payload('characters', id)
    const constraint = `rollback_audit_${randomUUID().replaceAll('-', '')}`
    await control.query(`ALTER TABLE security.audit_events ADD CONSTRAINT ${constraint} CHECK (target_id IS DISTINCT FROM '${id}' OR action<>'novel_entity_rolled_back') NOT VALID`)
    try {
      await expect(context(service, f, () => service.query("SELECT ai.rollback_entity_version($1,'characters',$2,1)", [f.workspace, id]))).rejects.toMatchObject({ code: '23514' })
      expect(await payload('characters', id)).toEqual(before)
      expect((await control.query('SELECT current_version_no FROM novel.characters WHERE id=$1', [id])).rows).toEqual([{ current_version_no: 2 }])
      expect((await control.query("SELECT count(*)::int AS count FROM novel.character_versions WHERE character_id=$1 AND source_type='rollback'", [id])).rows).toEqual([{ count: 0 }])
      expect((await service.query("SELECT current_setting('app.rollback_context',true) AS rollback,current_setting('app.publication_proposal_id',true) AS publication")).rows).toEqual([{ rollback: '', publication: '' }])
    } finally { await control.query(`ALTER TABLE security.audit_events DROP CONSTRAINT ${constraint}`) }
  })

  it('keeps proposal UUID immutable for both editor and assigned worker', async () => {
    const f = await seed(), id = await target(f, 'characters'), p = await proposal(f, 'characters', id, await payload('characters', id))
    await control.query("UPDATE ai.generation_runs SET agent_principal_id='novel-worker' WHERE id=$1", [f.run])
    await expect(context(runtime, f, () => runtime.query('UPDATE ai.generation_proposals SET id=$2 WHERE id=$1', [p, randomUUID()]))).rejects.toMatchObject({ code: '42501' })
    await expect(workerContext(f, () => worker.query('UPDATE ai.generation_proposals SET id=$2 WHERE id=$1', [p, randomUUID()]))).rejects.toMatchObject({ code: '42501' })
    expect((await control.query('SELECT source_id FROM novel.character_versions WHERE source_id=$1', [p])).rows).toEqual([{ source_id: p }])
  })

  it('keeps one candidate when a restricted worker retries the same proposal idempotency key', async () => {
    const f = await seed(), id = await target(f, 'characters'), content = await payload('characters', id), p = randomUUID(), key = randomUUID()
    await control.query("UPDATE ai.generation_runs SET agent_principal_id='novel-worker' WHERE id=$1", [f.run])
    const insert = (proposalId: string) => workerContext(f, () => worker.query(`INSERT INTO ai.generation_proposals(id,workspace_id,novel_id,generation_run_id,target_type,target_id,operation,proposed_content,validation_result,status,idempotency_key)
      VALUES($1,$2,$3,$4,'characters',$5,'create',$6,'{}','draft',$7) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`, [proposalId, f.workspace, f.novel, f.run, id, content, key]))
    await insert(p); await insert(randomUUID())
    expect((await control.query('SELECT id FROM ai.generation_proposals WHERE workspace_id=$1 AND idempotency_key=$2', [f.workspace, key])).rows).toEqual([{ id: p }])
    expect((await control.query('SELECT source_id,source_idempotency_key FROM novel.character_versions WHERE character_id=$1', [id])).rows).toEqual([{ source_id: p, source_idempotency_key: `proposal:${p}` }])
  })

  it.each(['outlines', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events'])(
    '%s publishes initial creation with precise service visibility', async (table) => {
      const f = await seed(), id = await longformTarget(f, table), content = await payload(table, id)
      const p = await proposal(f, table, id, content)
      const competitor = await proposal(f, table, id, content)
      await approve(f, p)
      await approve(f, competitor)
      await publish(f, p)
      await expect(publish(f, p)).rejects.toMatchObject({ code: 'P2003' })
      await expect(publish(f, competitor)).rejects.toMatchObject({ code: 'P2003' })
      expect((await control.query(`SELECT status FROM novel.${table} WHERE id=$1`, [id])).rows).toEqual([{ status: 'published' }])
      const update = await proposal(f, table, id, content, 1)
      await approve(f, update)
      await expect(publish(f, update)).rejects.toMatchObject({ code: 'P2004' })
      const outsider = await seed()
      expect((await context(service, outsider, () => service.query(`SELECT id FROM novel.${table} WHERE id=$1`, [id]))).rows).toHaveLength(0)
    },
  )

  it('creates worker candidates from persisted initiator and denies review, publish, rollback and forged GUCs', async () => {
    const f = await seed(), id = await target(f, 'characters'), content = await payload('characters', id), p = randomUUID()
    await control.query("UPDATE ai.generation_runs SET agent_principal_id='novel-worker' WHERE id=$1", [f.run])
    await workerContext(f, () => worker.query(`INSERT INTO ai.generation_proposals(id,workspace_id,novel_id,generation_run_id,target_type,target_id,operation,proposed_content,validation_result,status,idempotency_key)
      VALUES($1,$2,$3,$4,'characters',$5,'create',$6,'{}','draft',$7)`, [p, f.workspace, f.novel, f.run, id, content, randomUUID()]))
    expect((await control.query('SELECT created_by_user_id,source_generation_run_id FROM novel.character_versions WHERE source_id=$1', [p])).rows)
      .toEqual([{ created_by_user_id: f.user, source_generation_run_id: f.run }])
    await expect(workerContext(f, () => worker.query("UPDATE ai.generation_proposals SET status='approved',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1", [p, f.user]))).rejects.toMatchObject({ code: '42501' })
    await expect(workerContext(f, () => worker.query('SELECT * FROM ai.publish_generation_proposal($1,$2)', [f.workspace, p]))).rejects.toMatchObject({ code: '42501' })
    await expect(workerContext(f, () => worker.query("SELECT ai.rollback_entity_version($1,'characters',$2,1)", [f.workspace, id]))).rejects.toMatchObject({ code: '42501' })
    const forged = await workerContext(f, async () => {
      await worker.query(`SELECT set_config('app.rollback_context','1',true),set_config('app.database_role','dsh_service_runtime',true),
        set_config('app.publication_proposal_id',$1,true)`, [p])
      return worker.query('SELECT novel.rollback_context_active() AS active')
    })
    expect(forged.rows).toEqual([{ active: false }])
  })

  it('restores relation endpoints and clears legitimate null semantic values on rollback', async () => {
    const f = await seed(), id = await target(f, 'entity_relations'), initial = await payload('entity_relations', id)
    const first = await proposal(f, 'entity_relations', id, initial)
    await approve(f, first); await publish(f, first)
    const other = await target(f, 'characters')
    const changed = { ...initial, source_entity_id: other, strength: 9, source_version_no: 3, valid_from: '2026-01-01T00:00:00+00:00', valid_to: '2026-02-01T00:00:00+00:00' }
    const second = await proposal(f, 'entity_relations', id, changed, 1)
    await approve(f, second); await publish(f, second)
    await context(service, f, () => service.query("SELECT ai.rollback_entity_version($1,'entity_relations',$2,1)", [f.workspace, id]))
    expect(await payload('entity_relations', id)).toEqual(initial)
  })

  it('serializes simultaneous identical candidates with one winner and one unchanged approved loser', async () => {
    const { f, id, initial } = await publishedPair()
    const winner = await proposal(f, 'characters', id, initial, 2), loser = await proposal(f, 'characters', id, initial, 2)
    await approve(f, winner); await approve(f, loser)
    const locked = barrier(), release = barrier()
    const first = context(service, f, async () => {
      await publishStatement(service, f, winner)
      locked.release()
      await release.promise
    })
    await locked.promise
    const owner = (await service.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const waiter = (await service2.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const second = context(service2, f, () => publishStatement(service2, f, loser)).then(() => null, error => error as { code: string })
    try { await blockedBy(waiter, owner) } finally { release.release() }
    await first
    expect(await second).toMatchObject({ code: 'P2003' })
    expect((await control.query('SELECT status FROM ai.generation_proposals WHERE id=$1', [loser])).rows).toEqual([{ status: 'approved' }])
    expect((await control.query('SELECT status FROM novel.character_versions WHERE source_id=$1', [loser])).rows).toEqual([{ status: 'draft' }])
  })

  it.each(['publish', 'rollback'] as const)('serializes publish versus rollback when %s obtains the target lock first', async (firstOperation) => {
    const { f, id, initial } = await publishedPair()
    const p = await proposal(f, 'characters', id, { ...initial, name: 'Third' }, 2)
    await approve(f, p)
    const locked = barrier(), release = barrier()
    const rollback = (client: TestPgClient) => client.query("SELECT ai.rollback_entity_version($1,'characters',$2,1)", [f.workspace, id])
    const first = context(service, f, async () => {
      if (firstOperation === 'publish') await publishStatement(service, f, p)
      else await rollback(service)
      locked.release(); await release.promise
    })
    await locked.promise
    const owner = (await service.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const waiter = (await service2.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const second = context(service2, f, () => firstOperation === 'publish' ? rollback(service2) : publishStatement(service2, f, p))
      .then(() => null, error => error as { code: string })
    try { await blockedBy(waiter, owner) } finally { release.release() }
    await first
    if (firstOperation === 'rollback') expect(await second).toMatchObject({ code: 'P2003' })
    else expect(await second).toBeNull()
    expect(await payload('characters', id)).toEqual(initial)
  })

  it.each(['publish', 'rollback'] as const)('allows candidate creation while %s holds a non-key target lock', async (operation) => {
    const { f, id, initial, p } = await approvedThirdCharacterVersion()
    const locked = barrier(), release = barrier()
    const holding = context(service, f, async () => {
      if (operation === 'publish') await publishStatement(service, f, p)
      else await service.query("SELECT ai.rollback_entity_version($1,'characters',$2,1)", [f.workspace, id])
      locked.release(); await release.promise
    })
    await locked.promise
    const candidate = randomUUID()
    try {
      await workerContext(f, () => insertWorkerCandidate(f, candidate, id, initial))
    } finally { release.release() }
    await holding
    await expectStaleCandidate(f, candidate)
  })

  it.each(['publish', 'rollback'] as const)('allows %s while a new candidate holds an uncommitted foreign key reference', async (operation) => {
    const { f, id, initial, p } = await approvedThirdCharacterVersion()
    const candidate = randomUUID(), inserted = barrier(), release = barrier()
    const holding = workerContext(f, async () => {
      await insertWorkerCandidate(f, candidate, id, initial)
      inserted.release(); await release.promise
    })
    await inserted.promise
    try {
      if (operation === 'publish') await publish(f, p)
      else await context(service, f, () => service.query("SELECT ai.rollback_entity_version($1,'characters',$2,1)", [f.workspace, id]))
    } finally { release.release() }
    await holding
    await expectStaleCandidate(f, candidate)
  })

  it.each(['outlines', 'chapters', 'chapter_summaries', 'story_facts', 'timeline_events'])(
    '%s keeps published long-form content immutable through archive transitions', async (table) => {
      const f = await seed(), id = await longformTarget(f, table), content = await payload(table, id)
      const p = await proposal(f, table, id, content)
      await approve(f, p); await publish(f, p)
      await expect(context(runtime, f, () => runtime.query(`UPDATE novel.${table} SET status='draft' WHERE id=$1`, [id]))).rejects.toMatchObject({ code: '42501' })
      await context(runtime, f, () => runtime.query(`UPDATE novel.${table} SET status='archived' WHERE id=$1`, [id]))
      await expect(context(runtime, f, () => runtime.query(`UPDATE novel.${table} SET status='draft' WHERE id=$1`, [id]))).rejects.toMatchObject({ code: '42501' })
      const field = table === 'chapter_summaries' ? 'content_text' : table === 'story_facts' ? 'statement' : 'title'
      await expect(context(runtime, f, () => runtime.query(`UPDATE novel.${table} SET ${field}='Forged' WHERE id=$1`, [id]))).rejects.toMatchObject({ code: '42501' })
      expect(await payload(table, id)).toEqual(content)
    },
  )
})
