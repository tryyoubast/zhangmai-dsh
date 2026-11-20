import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { migrateDatabase } from '@deepseek-ai/dsh-database-postgres'
import { postgresTestEnvironment } from '../../../identity/user-auth/tests-postgres/environment.ts'
import { TestPgClient } from '../../../identity/user-auth/tests-postgres/pg-client.ts'

const config = postgresTestEnvironment()
const control = new TestPgClient({ connectionString: config.migrationUrl })
const migration = readFileSync(new URL('../../../database/database-postgres/migrations/0020_independent_proposal_publication.sql', import.meta.url), 'utf8')

beforeAll(async () => {
  await control.connect()
  const role = await control.query(`SELECT rolsuper,rolbypassrls,
    ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname<>session_user AND pg_has_role(session_user,oid,'MEMBER')) AS memberships
    FROM pg_roles WHERE rolname=session_user`)
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false, memberships: ['dsh_migrator'] }])
  await control.query('SET ROLE dsh_migrator')
  const latest = await control.query('SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations')
  expect(latest.rows).toEqual([{ latest: '1794441600002' }])
})
afterAll(async () => { await control.end() })

it('preserves 0019 history and audits, rejects reserved keys, and backfills exact candidates', async () => {
  const user = randomUUID(), workspace = randomUUID(), novel = randomUUID()
  const run = randomUUID(), session = randomUUID(), entity = randomUUID()
  await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at,email_verified_at)
    VALUES($1,$2,$2,'fixture','active',now(),now())`, [user, `${user}@test.invalid`])
  await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
    VALUES($1,$2,$3,'web',now()+interval '1 day',now())`, [session, user, randomUUID()])
  await control.query("INSERT INTO app.workspaces(id,owner_user_id,name,status) VALUES($1,$2,'Upgrade fixture','active')", [workspace, user])
  await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace, user])
  await control.query("INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id) VALUES($1,$2,'Upgrade fixture','draft',$3)", [novel, workspace, user])
  await control.query(`INSERT INTO ai.generation_runs(id,workspace_id,novel_id,initiated_by_user_id,agent_principal_id,model,prompt_version,source_session_id,status,idempotency_key,instruction,context_limit)
    VALUES($1,$2,$3,$4,'user-request','fixture','v1',$5,'queued',$6,'Fixture',0)`, [run, workspace, novel, user, session, randomUUID()])
  await control.query(`INSERT INTO novel.characters(id,workspace_id,novel_id,name,status,current_version_no,created_by_user_id)
    VALUES($1,$2,$3,'Historical','published',2,$4)`, [entity, workspace, novel, user])
  const content = { name: 'Historical', summary: null, attributes_jsonb: {}, attributes_schema_version: 1 }
  await control.query(`INSERT INTO novel.character_versions(workspace_id,novel_id,character_id,version_no,status,content_jsonb,source_type,created_by_user_id)
    VALUES($1,$2,$3,1,'published',$4,'manual',$5),($1,$2,$3,2,'published',$4,'manual',$5),($1,$2,$3,3,'draft',$4,'manual',$5)`, [workspace, novel, entity, content, user])
  const bound: string[] = []
  for (const status of ['draft', 'approved', 'rejected', 'expired', 'published']) {
    const p = randomUUID()
    await control.query(`INSERT INTO ai.generation_proposals(id,workspace_id,novel_id,generation_run_id,target_type,target_id,operation,base_version_no,proposed_content,validation_result,status,idempotency_key)
      VALUES($1,$2,$3,$4,'characters',$5,'update',2,$6,'{}','draft',$7)`, [p, workspace, novel, run, entity, content, randomUUID()])
    if (status !== 'draft') await control.query('UPDATE ai.generation_proposals SET status=$2,reviewed_by_user_id=$3,reviewed_at=now(),published_at=CASE WHEN $2=\'published\' THEN now() END WHERE id=$1', [p, status, user])
    if (status !== 'published') bound.push(p)
  }
  const unbound = randomUUID()
  await control.query(`INSERT INTO ai.generation_proposals(id,workspace_id,novel_id,generation_run_id,target_type,operation,proposed_content,validation_result,status,idempotency_key)
    VALUES($1,$2,$3,$4,'characters','create',$5,'{}','draft',$6)`, [unbound, workspace, novel, run, content, randomUUID()])
  const beforeHistory = (await control.query('SELECT to_jsonb(v) AS row FROM novel.character_versions v ORDER BY id')).rows
  const beforeAudits = (await control.query('SELECT to_jsonb(a) AS row FROM security.audit_events a ORDER BY id')).rows
  const collision = randomUUID()
  await control.query(`INSERT INTO novel.character_versions(id,workspace_id,novel_id,character_id,version_no,status,content_jsonb,source_type,source_idempotency_key,created_by_user_id)
    VALUES($1,$2,$3,$4,4,'draft',$5,'manual',$6,$7)`, [collision, workspace, novel, entity, content, `proposal:${bound[0]}`, user])
  await control.query('BEGIN')
  try {
    await expect(control.query(migration)).rejects.toMatchObject({ message: expect.stringContaining(`proposal ${bound[0]}, version IDs ${collision}`) })
  } finally { await control.query('ROLLBACK') }
  expect((await control.query('SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations')).rows).toEqual([{ latest: '1794441600002' }])
  await control.query('DELETE FROM novel.character_versions WHERE id=$1', [collision])
  await migrateDatabase(config.migrationUrl)
  const candidateRows = await control.query(`SELECT source_id,version_no,status,source_idempotency_key,source_generation_run_id,created_by_user_id,content_jsonb
    FROM novel.character_versions WHERE source_type='generation_proposal' ORDER BY source_id`)
  expect(candidateRows.rows).toEqual(bound.sort().map(p => ({ source_id: p, version_no: 3, status: 'draft', source_idempotency_key: `proposal:${p}`,
    source_generation_run_id: run, created_by_user_id: user, content_jsonb: content })))
  expect((await control.query("SELECT to_jsonb(v) AS row FROM novel.character_versions v WHERE source_type<>'generation_proposal' ORDER BY id")).rows).toEqual(beforeHistory)
  expect((await control.query('SELECT to_jsonb(a) AS row FROM security.audit_events a ORDER BY id')).rows).toEqual(beforeAudits)
  expect((await control.query('SELECT id FROM novel.character_versions WHERE source_id=$1', [unbound])).rows).toHaveLength(0)
})
