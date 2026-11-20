import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDatabase, sql, withRequestContext, type DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import { PostgresNovelContextRepository } from '../src/context-repository.ts'
import { postgresTestEnvironment } from '../../../identity/user-auth/tests-postgres/environment.ts'
import { TestPgClient } from '../../../identity/user-auth/tests-postgres/pg-client.ts'

const config = postgresTestEnvironment()
const control = new TestPgClient({ connectionString: config.migrationUrl })
const database = createDatabase({
  url: config.runtimeUrl, runtimeRole: 'dsh_worker_runtime', maxConnections: 1,
  idleTimeoutMs: 5_000, connectionTimeoutMs: 5_000, applicationName: `context-retrieval-${randomUUID()}`,
})
const userId = randomUUID()
const sessionId = randomUUID()
const workspaceId = randomUUID()
const novelId = randomUUID()
const characterId = randomUUID()
const sourceIds = {
  outline: randomUUID(), chapter: randomUUID(), chapter_version: randomUUID(), chapter_summary: randomUUID(),
  story_fact: randomUUID(), timeline_event: randomUUID(), character: characterId, skill: randomUUID(),
  location: randomUUID(), faction: randomUUID(), item: randomUUID(), storyline: randomUUID(),
  entity_relation: randomUUID(), character_skill: randomUUID(),
}
const otherNovelId = randomUUID()
const otherWorkspaceId = randomUUID()
const foreignNovelId = randomUUID()
const quotedCharacterId = randomUUID()
const outsiderUserId = randomUUID()
const outsiderSessionId = randomUUID()
const principal: AuthPrincipal = {
  userId, sessionId, workspaceId, actorType: 'agent', agentPrincipalId: 'novel-worker', clientType: 'browser', roles: ['owner'],
}
const repository = new PostgresNovelContextRepository(database, principal)
// Keep the real continuation instruction exact so this regression exercises its AND-query failure.
const instruction = 'Continue the saved Moon Harbor story context. Return only JSON with records: one new character named Lantern Courier (targetType characters, name, summary), one new location named Lantern Pier (targetType locations, name, summary), and chapter 2 (targetType chapters, chapterNo:2, title:Moon Harbor Continuation, summary). Keep the combined prose under 120 words. Drafts only; do not update or publish existing records.'

beforeAll(async () => {
  await control.connect()
  const login = await control.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = session_user')
  expect(login.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
  const memberships = await control.query(`SELECT rolname FROM pg_roles
    WHERE rolname <> session_user AND pg_has_role(session_user, oid, 'MEMBER')`)
  expect(memberships.rows).toEqual([{ rolname: 'dsh_migrator' }])
  await control.query('SET ROLE dsh_migrator')
  await control.query("SET statement_timeout = '15s'")
  await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at,email_verified_at)
    VALUES ($1,$2,$2,'fixture','active',now(),now())`, [userId, `${userId}@test.invalid`])
  await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
    VALUES ($1,$2,$3,'web',now()+interval '1 day',now())`, [sessionId, userId, randomUUID()])
  await control.query("INSERT INTO app.workspaces(id,owner_user_id,name,status) VALUES ($1,$2,'Context fixture','active')", [workspaceId, userId])
  await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, userId])
  await control.query(`INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id)
    VALUES ($1,$2,'Context fixture','draft',$3)`, [novelId, workspaceId, userId])
  await control.query(`INSERT INTO novel.characters(id,workspace_id,novel_id,name,summary,status,created_by_user_id)
    VALUES ($1,$2,$3,'Moon Harbor courier','Carries the tide chart','draft',$4)`, [characterId, workspaceId, novelId, userId])
  for (const [table, id] of [
    ['skills', sourceIds.skill], ['locations', sourceIds.location], ['factions', sourceIds.faction],
    ['items', sourceIds.item], ['storylines', sourceIds.storyline],
  ] as const) {
    await control.query(`INSERT INTO novel.${table}(id,workspace_id,novel_id,name,summary,status,created_by_user_id)
      VALUES ($1,$2,$3,'Moon Harbor','Tide chart','draft',$4)`, [id, workspaceId, novelId, userId])
  }
  await control.query(`INSERT INTO novel.outlines(id,workspace_id,novel_id,title,content_jsonb,status,created_by_user_id)
    VALUES ($1,$2,$3,'Moon Harbor','{}','draft',$4)`, [sourceIds.outline, workspaceId, novelId, userId])
  await control.query(`INSERT INTO novel.chapters(id,workspace_id,novel_id,chapter_no,title,summary,status,created_by_user_id)
    VALUES ($1,$2,$3,1,'Moon Harbor','Tide chart','draft',$4)`, [sourceIds.chapter, workspaceId, novelId, userId])
  await control.query(`INSERT INTO novel.chapter_versions(id,workspace_id,novel_id,chapter_id,version_no,status,
    content_sha256,content_bytes,content_storage_kind,content_text,source_type,created_by_user_id)
    VALUES ($1,$2,$3,$4,1,'draft',$5,11,'postgres_text','Moon Harbor','manual',$6)`,
  [sourceIds.chapter_version, workspaceId, novelId, sourceIds.chapter, 'a'.repeat(64), userId])
  await control.query(`INSERT INTO novel.chapter_summaries(id,workspace_id,novel_id,chapter_id,chapter_version_id,
    summary_kind,content_text,content_sha256,status,created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,'short','Moon Harbor',$6,'draft',$7)`,
  [sourceIds.chapter_summary, workspaceId, novelId, sourceIds.chapter, sourceIds.chapter_version, 'b'.repeat(64), userId])
  await control.query(`INSERT INTO novel.story_facts(id,workspace_id,novel_id,fact_key,statement,status,created_by_user_id)
    VALUES ($1,$2,$3,'tide','Moon Harbor','draft',$4)`, [sourceIds.story_fact, workspaceId, novelId, userId])
  await control.query(`INSERT INTO novel.timeline_events(id,workspace_id,novel_id,event_key,title,status,created_by_user_id)
    VALUES ($1,$2,$3,'arrival','Moon Harbor','draft',$4)`, [sourceIds.timeline_event, workspaceId, novelId, userId])
  await control.query(`INSERT INTO novel.entity_relations(id,workspace_id,novel_id,source_entity_type,source_entity_id,
    target_entity_type,target_entity_id,relation_type,attributes_jsonb,status,created_by_user_id)
    VALUES ($1,$2,$3,'characters',$4,'locations',$5,'visits','{"setting":"Moon Harbor"}','draft',$6)`,
  [sourceIds.entity_relation, workspaceId, novelId, characterId, sourceIds.location, userId])
  await control.query(`INSERT INTO novel.character_skills(id,workspace_id,novel_id,character_id,skill_id,
    relation_type,attributes_jsonb,status,created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,'practices','{"setting":"Moon Harbor"}','draft',$6)`,
  [sourceIds.character_skill, workspaceId, novelId, characterId, sourceIds.skill, userId])
  for (const [status, deleted] of [['archived', false], ['deleted', false], ['draft', true]] as const) {
    await control.query(`INSERT INTO novel.characters(id,workspace_id,novel_id,name,status,deleted_at,created_by_user_id)
      VALUES ($1,$2,$3,'hiddenbeacon Moon Harbor',$4,CASE WHEN $5 THEN now() END,$6)`,
    [randomUUID(), workspaceId, novelId, status, deleted, userId])
  }
  await control.query(`INSERT INTO novel.characters(id,workspace_id,novel_id,name,status,created_by_user_id)
    VALUES ($1,$2,$3,$4,'draft',$5)`, [quotedCharacterId, workspaceId, novelId, "O'Reilly's quay", userId])
  await control.query("INSERT INTO app.workspaces(id,owner_user_id,name,status) VALUES ($1,$2,'Foreign context','active')", [otherWorkspaceId, userId])
  await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [otherWorkspaceId, userId])
  for (const [id, scope] of [[otherNovelId, workspaceId], [foreignNovelId, otherWorkspaceId]]) {
    await control.query(`INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id)
      VALUES ($1,$2,'Other novel','draft',$3)`, [id, scope, userId])
    await control.query(`INSERT INTO novel.characters(id,workspace_id,novel_id,name,status,created_by_user_id)
      VALUES ($1,$2,$3,'scopebeacon Moon Harbor','draft',$4)`, [randomUUID(), scope, id, userId])
  }
  await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at,email_verified_at)
    VALUES ($1,$2,$2,'fixture','active',now(),now())`, [outsiderUserId, `${outsiderUserId}@test.invalid`])
  await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
    VALUES ($1,$2,$3,'web',now()+interval '1 day',now())`, [outsiderSessionId, outsiderUserId, randomUUID()])
})

afterAll(async () => { await Promise.all([database.close(), control.end()]) })

describe('context retrieval under restricted PostgreSQL worker RLS', () => {
  it('retrieves known Moon Harbor context after the original long instruction has no strict match', async () => {
    const strict = await withRequestContext(database, {
      userId, workspaceId, actorType: 'agent', agentPrincipalId: 'novel-worker',
    }, async db => (await db.execute(sql`SELECT current_user AS role,
      (SELECT count(*)::integer FROM novel.characters
       WHERE workspace_id = ${workspaceId}::uuid AND novel_id = ${novelId}::uuid
         AND to_tsvector('simple', left(name || E'\\n' || coalesce(summary, '') || E'\\n' || attributes_jsonb::text, 16384))
           @@ plainto_tsquery('simple', ${instruction})) AS matches`)).rows)
    expect(strict).toEqual([{ role: 'dsh_worker_runtime', matches: 0 }])

    const candidates = await repository.findCandidates({ workspaceId, novelId, instruction })
    expect(Object.fromEntries(candidates.map(value => [value.sourceType, value.sourceId]))).toEqual(sourceIds)
    expect(candidates).toHaveLength(14)
    expect(candidates.every(value => value.relevanceScore > 0)).toBe(true)
  })

  it('keeps a visible strict match ahead of all broader matches', async () => {
    const candidates = await repository.findCandidates({ workspaceId, novelId, instruction: 'Moon Harbor courier' })
    expect(candidates.map(value => value.sourceId)).toEqual([characterId])
  })

  it.each(['', '   ', '!!! | & <-> :* ( )', 'unmatchedlexeme'])('returns no unrelated context for %j', async (text) => {
    await expect(repository.findCandidates({ workspaceId, novelId, instruction: text })).resolves.toEqual([])
  })

  it.each(['Moon | unmatchedlexeme', 'Moon & !unmatchedlexeme', 'Moon <-> unmatchedlexeme', 'Moon:* (unmatchedlexeme)', "Moon \\ | ' unmatchedlexeme"])(
    'treats operators in %j as instruction text', async (text) => {
      const candidates = await repository.findCandidates({ workspaceId, novelId, instruction: text })
      expect(new Set(candidates.map(value => value.sourceId))).toEqual(new Set(Object.values(sourceIds)))
    },
  )

  it('quotes normalized apostrophe lexemes before constructing the fallback tsquery', async () => {
    const candidates = await repository.findCandidates({ workspaceId, novelId, instruction: "O'Reilly's unmatchedlexeme" })
    expect(candidates.map(value => value.sourceId)).toEqual([quotedCharacterId])
    expect(candidates[0]?.relevanceScore).toBeGreaterThan(0)
  })

  it('excludes archived, deleted, and soft-deleted records from the fallback', async () => {
    await expect(repository.findCandidates({ workspaceId, novelId, instruction: 'hiddenbeacon unmatchedlexeme' })).resolves.toEqual([])
  })

  it('keeps other novels and workspaces out of fallback results', async () => {
    await expect(repository.findCandidates({ workspaceId, novelId, instruction: 'scopebeacon unmatchedlexeme' })).resolves.toEqual([])
    await expect(repository.findCandidates({ workspaceId: otherWorkspaceId, novelId: foreignNovelId, instruction })).rejects.toThrow('workspace context mismatch')
    await expect(repository.findCandidates({ workspaceId, novelId: foreignNovelId, instruction })).resolves.toEqual([])
  })

  it('hides all sources from a valid user without workspace membership despite an owner hint', async () => {
    const outsider = new PostgresNovelContextRepository(database, {
      ...principal, userId: outsiderUserId, sessionId: outsiderSessionId,
    })
    await expect(outsider.findCandidates({ workspaceId, novelId, instruction })).resolves.toEqual([])
  })

  it('records the natural worker query plan for the complete emitted fallback query', async () => {
    const queries: Parameters<DshDatabase['execute']>[0][] = []
    const originalTransaction = database.db.transaction.bind(database.db)
    const transactionSpy = vi.spyOn(database.db, 'transaction').mockImplementationOnce((callback, options) => originalTransaction(async (transaction) => {
      const executeSpy = vi.spyOn(transaction, 'execute')
      try {
        return await callback(transaction)
      } finally {
        queries.push(...executeSpy.mock.calls.map(call => call[0]))
        executeSpy.mockRestore()
      }
    }, options))
    try {
      const candidates = await repository.findCandidates({ workspaceId, novelId, instruction })
      expect(candidates).toHaveLength(14)
    } finally {
      transactionSpy.mockRestore()
    }
    expect(queries).toHaveLength(6)
    const fallbackQuery = queries.at(-1)
    if (fallbackQuery === undefined || typeof fallbackQuery === 'string') throw new Error('Expected the emitted fallback SQL query')
    const plan = await withRequestContext(database, {
      userId, workspaceId, actorType: 'agent', agentPrincipalId: 'novel-worker',
    }, async db => (await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${fallbackQuery}`)).rows)
    expect(plan).toHaveLength(1)
    console.info('CONTEXT_RETRIEVAL_WORKER_PLAN', JSON.stringify(plan))
  })
})
