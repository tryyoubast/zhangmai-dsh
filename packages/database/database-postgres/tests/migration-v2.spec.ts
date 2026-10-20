import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrationStatements, resolveMigrationsDirectory } from '../src/database.ts'

const migrationPath = resolve(import.meta.dirname, '../migrations/0002_workspace_drafts_and_hardening.sql')
const bootstrapPath = resolve(import.meta.dirname, '../scripts/bootstrap-migrator-ownership.sql')
const queueClaimPath = resolve(import.meta.dirname, '../migrations/0010_generation_queue_claim.sql')
const queueClaimHardeningPath = resolve(import.meta.dirname, '../migrations/0011_generation_claim_rls_hardening.sql')

function migrationSql(): string {
  return readFileSync(migrationPath, 'utf8')
}

function functionSql(name: string): string {
  const sql = migrationSql()
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}`)
  if (start < 0) return ''
  const end = sql.indexOf('$$;', start)
  return end < 0 ? '' : sql.slice(start, end + 3)
}

function queueClaimSql(): string {
  return readFileSync(queueClaimPath, 'utf8')
}

function queueClaimHardeningSql(): string {
  return readFileSync(queueClaimHardeningPath, 'utf8')
}

describe('PostgreSQL authoring hardening migration', () => {
  it('keeps the released baseline migration inside the runner transaction', () => {
    const baseline = readFileSync(resolve(import.meta.dirname, '../migrations/0001_auth_workspace_novel_ai.sql'), 'utf8')
    const statements = migrationStatements(baseline)
    expect(statements[0]).not.toMatch(/^\s*BEGIN\s*;/i)
    expect(statements.at(-1)).not.toMatch(/\bCOMMIT\s*;\s*$/i)
    expect(statements.some(statement => statement.includes('CREATE EXTENSION IF NOT EXISTS pgcrypto;'))).toBe(true)
  })

  it('resolves migrations from the bundled package entry point', () => {
    const packageRoot = resolve(import.meta.dirname, '..')
    const migrationDirectory = resolveMigrationsDirectory(pathToFileURL(resolve(packageRoot, 'lib/index.js')).href)
    expect(migrationDirectory).toBe(resolve(packageRoot, 'migrations'))
    expect(readFileSync(resolve(migrationDirectory, 'meta/_journal.json'), 'utf8')).toContain('0012_generation_context_snapshots')
  })

  it('revokes public function access and defaults future objects to private', () => {
    const sql = migrationSql()
    expect(sql).toContain('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA')
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE dsh_migrator')
  })

  it('binds row access to the selected workspace and prevents cross-workspace references', () => {
    const sql = migrationSql()
    expect(sql).toContain("current_setting('app.workspace_id', true)")
    expect(sql).toContain('FOREIGN KEY (workspace_id, novel_id)')
    expect(sql).toContain('FOREIGN KEY (workspace_id, novel_id, character_id)')
    expect(sql).toContain('FOREIGN KEY (workspace_id, novel_id, skill_id)')
    expect(sql).toContain('validate_entity_relation')
    expect(sql).toContain('validate_generation_proposal')
    expect(sql).toContain('cannot migrate an entity relation that crosses a workspace or novel')
    expect(sql).toContain('cannot migrate a proposal that references an entity outside its workspace or novel')
    expect(sql).toContain("proposal.status='approved'")
  })

  it('adds versioned draft entities and prevents workers from publishing them', () => {
    const sql = migrationSql()
    for (const [table, versions] of [
      ['locations', 'location_versions'],
      ['factions', 'faction_versions'],
      ['items', 'item_versions'],
      ['storylines', 'storyline_versions'],
    ]) {
      expect(sql).toContain(`novel.${table}`)
      expect(sql).toContain(`novel.${versions}`)
    }
    expect(sql).toContain('entity_relation_versions')
    expect(sql).toContain("status='draft'")
    expect(sql).toContain('dsh_worker_runtime')
  })

  it('defines each constraint and policy once and guards every publishable record', () => {
    const sql = migrationSql()
    const constraintNames = [...sql.matchAll(/^ALTER TABLE [\w.]+ ADD CONSTRAINT (\w+)/gm)].map(match => match[1])
    const policyNames = [...sql.matchAll(/^CREATE POLICY (\w+)/gm)].map(match => match[1])
    expect(new Set(constraintNames).size).toBe(constraintNames.length)
    expect(new Set(policyNames).size).toBe(policyNames.length)
    const triggerNames = [...sql.matchAll(/^CREATE TRIGGER (\w+)/gm)].map(match => match[1])
    expect(new Set(triggerNames).size).toBe(triggerNames.length)

    for (const table of [
      'characters', 'character_versions', 'skills', 'skill_versions', 'character_skills',
      'entity_relations', 'entity_relation_versions', 'locations', 'location_versions',
      'factions', 'faction_versions', 'items', 'item_versions', 'storylines', 'storyline_versions',
    ]) {
      expect(sql).toContain(`'${table}'`)
    }
    expect(sql).toContain("table_name||'_guard_publication'")
    expect(sql).toMatch(new RegExp([
      'GRANT SELECT,INSERT,UPDATE ON novel\\.locations,\\s*novel\\.factions,',
      ' novel\\.items, novel\\.storylines TO dsh_app_runtime',
    ].join('')))
    expect(sql).toMatch(new RegExp([
      'GRANT SELECT,INSERT ON novel\\.location_versions, novel\\.faction_versions,',
      ' novel\\.item_versions,\\s*novel\\.storyline_versions,',
      ' novel\\.entity_relation_versions TO dsh_app_runtime',
    ].join('')))
    expect(sql).toContain('CREATE POLICY locations_editor_write ON novel.locations FOR ALL TO dsh_app_runtime')
    expect(sql).toContain('CREATE POLICY locations_member_read ON novel.locations FOR SELECT TO dsh_app_runtime,dsh_worker_runtime')
    expect(sql).toContain("OLD.status = 'published' AND NEW.status NOT IN ('published', 'archived', 'deleted')")
    expect(sql).toContain("proposal.status='approved'")
    expect(sql).toContain('proposal.base_version_no=OLD.current_version_no')
    expect(sql).toContain('proposal.proposed_content=OLD.content_jsonb')
    expect(sql).toContain("NEW.workspace_id, NEW.novel_id, NEW.version_no, approved_proposal.id, 'draft'")
    expect(sql).toContain('proposal.reviewed_by_user_id IS NOT NULL')
    expect(sql).toContain("OLD.status <> 'draft' OR NEW.status <> 'published'")
    expect(sql).toContain('NEW.target_id IS NOT NULL')
    expect(sql).toContain("to_jsonb(NEW) - 'updated_at'")
  })

  it('ties every generated domain record to a same-workspace run and bounds run transitions', () => {
    const sql = migrationSql()
    const baseline = readFileSync(resolve(import.meta.dirname, '../migrations/0001_auth_workspace_novel_ai.sql'), 'utf8')
    expect(sql).toContain('FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id)')
    expect(sql).not.toContain("OLD.status='queued' AND NEW.status IN ('running','cancelled')")
    expect(sql).toContain("OLD.status='queued' AND NEW.status='running'")
    expect(sql).toContain("WHERE status IN ('queued', 'running') AND completed_at IS NOT NULL")
    expect(baseline).toContain("CHECK (status IN ('draft', 'approved', 'rejected', 'published', 'expired'))")
    expect(sql).not.toContain('ADD CONSTRAINT generation_proposals_status_check')
    expect(sql).toContain("SET error_code='LEGACY_ERROR'")
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION app.agent_run_allowed(UUID,UUID,UUID) TO dsh_worker_runtime')
    expect(sql).toMatch(new RegExp([
      'CREATE POLICY ai_runs_worker_read ON ai\\.generation_runs FOR SELECT TO dsh_worker_runtime\\s+',
      'USING \\(app\\.agent_run_allowed\\(workspace_id,\\s*novel_id, id\\)\\)',
    ].join('')))
    expect(sql).toMatch(new RegExp([
      'CREATE POLICY ai_runs_worker_update ON ai\\.generation_runs FOR UPDATE TO dsh_worker_runtime\\s+',
      "USING \\(status IN \\('queued','running'\\) AND app\\.agent_run_allowed\\(workspace_id,\\s*novel_id, id\\)\\)\\s+",
      "WITH CHECK \\(status IN \\('running','completed','failed','cancelled'\\) AND app\\.agent_run_allowed\\(workspace_id,\\s*novel_id, id\\)\\)",
    ].join('')))
    for (const constraint of [
      'characters_workspace_generation_run_fkey', 'character_versions_workspace_novel_run_fkey',
      'skills_workspace_generation_run_fkey', 'skill_versions_workspace_novel_run_fkey',
      'character_skills_run_fkey', 'entity_relations_run_fkey', 'entity_relation_versions_run_fkey',
    ]) expect(sql).toContain(constraint)
    expect(sql).toContain('NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key')
    expect(sql).toContain('NEW.base_version_no IS DISTINCT FROM OLD.base_version_no')
  })

  it('binds approved-version SQL parameters and revokes the exact function signature', () => {
    const sql = migrationSql()
    const definition = functionSql('novel.approved_version_exists(')
    expect(definition).toContain('requested_version_status TEXT')
    expect(definition).toMatch(new RegExp([
      'USING requested_proposal_id, requested_target_id, requested_workspace_id,\\s*',
      'requested_novel_id, requested_version_no, requested_type, requested_version_status',
    ].join('')))
    expect(definition).toContain("proposal.operation IN (''create'',''link'')")
    expect(migrationSql()).toContain("target_type <> 'character_skills' OR operation IN ('link','update')")
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION novel.approved_version_exists(TEXT,UUID,UUID,UUID,INTEGER,UUID,TEXT) FROM PUBLIC')
  })

  it('allows workers to advance run heartbeats without clearing or backdating them', () => {
    const definition = functionSql('ai.guard_generation_run_transition()')
    const insertGuard = definition.slice(definition.indexOf("IF TG_OP = 'INSERT'"), definition.indexOf('RETURN NEW;', definition.indexOf("IF TG_OP = 'INSERT'")))
    expect(insertGuard).toContain('NEW.heartbeat_at IS NOT NULL')
    expect(definition).toContain('NEW.heartbeat_at IS NULL OR NEW.heartbeat_at < OLD.heartbeat_at')
    expect(definition).toContain('NEW.heartbeat_at > statement_timestamp()')
  })

  it('audits generation-run lifecycle changes without copying error summaries', () => {
    const sql = migrationSql()
    const audit = functionSql('ai.audit_generation_run_change()')
    expect(audit).toContain('security.audit_events')
    expect(sql).toContain('AFTER INSERT ON ai.generation_runs')
    expect(sql).toContain('AFTER UPDATE OF status ON ai.generation_runs')
    expect(audit).not.toContain('error_summary')
  })

  it('keeps worker-owned run provenance and proposal base versions immutable', () => {
    const entityGuard = functionSql('novel.guard_draft_publication()')
    const proposalGuard = functionSql('ai.guard_generation_proposal_transition()')
    expect(entityGuard).toContain('NEW.source_generation_run_id IS DISTINCT FROM OLD.source_generation_run_id')
    expect(proposalGuard).toMatch(/current_user='dsh_worker_runtime' AND[\s\S]*?NEW.base_version_no IS DISTINCT FROM OLD.base_version_no/)
  })

  it('guards proposal review transitions only on updates and binds writes to idempotency keys', () => {
    const sql = migrationSql()
    expect(sql).toMatch(/IF TG_OP='INSERT' THEN[\s\S]+?RETURN NEW;\s+END IF;\s+IF current_user='dsh_worker_runtime'/)
    expect(sql).toContain("IF current_user='dsh_app_runtime' AND NOT (")
    expect(sql).toContain("IF current_user='dsh_service_runtime' AND NOT (OLD.status='approved' AND NEW.status='published')")
    expect(sql).toContain('generation_runs_workspace_idempotency_idx')
    expect(sql).toContain('source_idempotency_key')
    expect(sql).toContain('idempotency_idx')
    expect(sql).toContain('NEW.source_idempotency_key IS NULL')
    expect(sql).toContain("(OLD.status='rejected' AND NEW.status='draft')")
    expect(sql).toContain('NEW.base_version_no IS DISTINCT FROM OLD.base_version_no')
    expect(sql).toContain('NEW.target_id IS NULL OR NEW.reviewed_by_user_id IS NOT NULL')
    expect(sql).toContain('NEW.published_at IS NULL')
    expect(sql).toContain('OLD.target_id IS NULL AND NEW.target_id IS NOT NULL')
  })

  it('keeps legacy create proposals migratable but requires a bound target before review', () => {
    const sql = migrationSql()
    expect(sql).toContain("OR (status = 'draft' AND operation = 'create' AND target_id IS NULL AND base_version_no IS NULL)")
    expect(sql).toContain('NEW.target_id IS NULL OR NEW.reviewed_by_user_id IS NOT NULL')
    expect(sql).toContain('OLD.target_id IS NULL AND NEW.target_id IS NOT NULL')
  })

  it('uses one workspace-scoped reference check for each supported entity type', () => {
    const sql = migrationSql()
    const referenceCases = [...sql.matchAll(/WHEN 'character_skills' THEN RETURN EXISTS/g)]
    expect(referenceCases).toHaveLength(1)
    expect(sql).toContain('character_skills ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid()')
    expect(sql).toContain('proposal.target_type=TG_TABLE_NAME AND proposal.target_id=OLD.id')
    expect(sql).toContain("WHEN 'character_skills' THEN 'character_skill_versions'")
  })

  it('prevents workspace admins from granting or transferring owner authority', () => {
    const sql = migrationSql()
    expect(sql).toContain('app.guard_workspace_owner_changes()')
    expect(sql).toContain('app.transfer_workspace_owner(UUID,UUID)')
    expect(sql).toContain("NEW.role = 'owner'")
    expect(sql).toContain("OLD.role = 'owner'")
    expect(sql).toContain('BEFORE UPDATE ON app.workspaces')
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON app.workspace_members')
  })

  it('publishes the reviewed version row in place and checks its exact proposed content', () => {
    const sql = migrationSql()
    expect(sql).toContain("IF OLD.status <> 'draft' OR NEW.status <> 'published' OR NOT FOUND")
    expect(sql).toContain('GRANT SELECT,UPDATE ON novel.character_versions')
    expect(sql).toContain('proposal.proposed_content=OLD.content_jsonb')
    expect(sql).toContain('publication_target_id')
    expect(sql).toContain("proposal.operation IN ('create','link') AND proposal.base_version_no IS NULL AND OLD.version_no=1")
    expect(sql).toContain("proposal.operation='update' AND proposal.base_version_no=OLD.version_no-1")
  })

  it('requires draft edits to be saved before a reviewer changes proposal state', () => {
    const sql = migrationSql()
    expect(sql).toContain("NEW.status IN ('approved','rejected','expired')")
    expect(sql).toContain('NEW.proposed_content IS DISTINCT FROM OLD.proposed_content')
    expect(sql).toContain('NEW.validation_result IS DISTINCT FROM OLD.validation_result')
    expect(sql).toContain('NEW.conflict_result IS DISTINCT FROM OLD.conflict_result')
  })

  it('writes append-only audit events for reviews and publication inside the database transaction', () => {
    const sql = migrationSql()
    expect(sql).toContain('CREATE OR REPLACE FUNCTION ai.audit_generation_proposal_change()')
    expect(sql).toContain('AFTER UPDATE OF status ON ai.generation_proposals')
    expect(sql).toContain("'ai_proposal_published'")
    expect(sql).toContain('security.audit_events')
  })

  it('publishes the existing reviewed draft version without duplicating its version number', () => {
    const sql = migrationSql()
    expect(sql).toContain("IF OLD.status <> 'draft' OR NEW.status <> 'published' OR NOT FOUND")
    expect(sql).toContain('GRANT SELECT,UPDATE ON novel.character_versions')
    expect(sql).toContain("proposal.operation IN ('create','link') AND proposal.base_version_no IS NULL AND OLD.version_no=1")
    expect(sql).toContain("proposal.operation='update' AND proposal.base_version_no=OLD.version_no-1")
  })

  it('backfills and versions character-skill relationship records', () => {
    const sql = migrationSql()
    const schema = readFileSync(resolve(import.meta.dirname, '../src/schema.ts'), 'utf8')
    expect(sql).toContain('ALTER TABLE novel.character_skills ADD COLUMN attributes_jsonb JSONB NOT NULL DEFAULT')
    expect(sql).toContain('CREATE TABLE novel.character_skill_versions')
    expect(sql).toContain('INSERT INTO novel.character_skill_versions')
    expect(sql).toContain("WHEN 'character_skill_versions' THEN 'character_skills'")
    expect(sql).toContain("WHEN 'character_skill_versions' THEN NEW.character_skill_id")
    expect(schema).toContain("'character_skill_versions'")
  })

  it('validates character-skill publication payloads against the relationship row', () => {
    const definition = functionSql('novel.entity_payload_matches(')
    expect(definition).toContain("WHEN 'character_skills' THEN proposed_content = jsonb_build_object(")
    expect(definition).toContain("'character_id', row_content->'character_id'")
    expect(definition).toContain("'source_version_no', row_content->'source_version_no'")
    expect(definition).toContain("'attributes_schema_version', row_content->'attributes_schema_version'")
  })

  it('pins the Drizzle authoring schema to workspace-scoped idempotency constraints', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      files: string[]
      scripts: Record<string, string>
    }
    const schema = readFileSync(resolve(import.meta.dirname, '../src/schema.ts'), 'utf8')
    expect(packageJson.files).toContain('migrations/meta/_journal.json')
    expect(packageJson.scripts).toHaveProperty('db:migrate')
    for (const table of [
      'characters', 'character_versions', 'skills', 'skill_versions', 'locations', 'location_versions',
      'factions', 'faction_versions', 'items', 'item_versions', 'storylines', 'storyline_versions',
      'character_skills', 'entity_relations', 'entity_relation_versions',
    ]) {
      expect(schema).toContain(`'${table}_workspace_idempotency_idx'`)
    }
    expect(schema).toContain("idempotencyKey: text('idempotency_key').notNull()")
    expect(schema).toContain("id: uuid('id').notNull().defaultRandom()")
    expect(schema).toContain("${table.operation} IN ('create', 'link') AND ${table.baseVersionNo} IS NULL")
    expect(schema).toContain("${table.status} = 'draft' AND ${table.operation} = 'create' AND ${table.targetId} IS NULL")
    expect(migrationSql()).toMatch(/OR \(status = 'draft' AND operation = 'create' AND target_id IS NULL AND base_version_no IS NULL\)/)
  })

  it('uses deployment credentials for Drizzle checks and packed migrations', () => {
    const config = readFileSync(resolve(import.meta.dirname, '../drizzle.config.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(config).toContain('resolveMigrationDatabaseUrl()')
    expect(config).not.toContain('process.env.DATABASE_URL')
    expect(readFileSync(resolve(import.meta.dirname, '../src/config.ts'), 'utf8')).toContain('DATABASE_MIGRATION_URL')
    expect(packageJson.scripts['db:migrate']).toContain('scripts/migrate.js')
  })

  it('records the trusted-service GUC threat boundary in package documentation', () => {
    const readme = readFileSync(resolve(import.meta.dirname, '../README.md'), 'utf8')
    expect(readme).toContain('trusted service transaction context')
    expect(readme).toContain('must not be exposed to model-generated SQL')
  })

  it('does not expose generated security functions to PUBLIC by default', () => {
    const sql = migrationSql()
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION app.transfer_workspace_owner(UUID,UUID) FROM PUBLIC')
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION novel.approved_version_exists')
    expect(sql).toContain('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA auth,app,novel,ai,security FROM PUBLIC')
  })

  it('ships the migration runner and its SQL files in the published package', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      files: string[]
    }
    expect(packageJson.files).toContain('lib/index.js')
    expect(packageJson.files).toContain('lib/types/**/*.d.ts')
    expect(packageJson.files).toContain('migrations/**/*.sql')
    expect(packageJson.files).toContain('migrations/meta/_journal.json')
    expect(packageJson.files).toContain('scripts/**/*.js')
    expect(packageJson.files).toContain('scripts/**/*.sql')
  })

  it('keeps pooled connections releasable when migration cleanup fails', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/database.ts'), 'utf8')
    expect(source).toMatch(new RegExp([
      'if \\(advisoryLockAcquired && releaseWithError === undefined\\) \\{\\s+',
      'await client\\.query\\(\\x27SELECT pg_advisory_unlock',
    ].join('')))
    expect(source).toMatch(/finally \{\s+client\.release\(releaseWithError\)/)
    expect(source).toContain('baseline 0001 and its DBA ownership bootstrap must run before migrateDatabase()')
  })

  it('provides a DBA-only ownership bootstrap without broad reassignment', () => {
    const sql = readFileSync(bootstrapPath, 'utf8')
    const baseline = readFileSync(resolve(import.meta.dirname, '../migrations/0001_auth_workspace_novel_ai.sql'))
    expect(sql).toContain('rolsuper')
    expect(sql).toContain("'dsh_migrator'")
    expect(sql).toContain("nspname IN ('auth', 'app', 'novel', 'ai', 'security', 'drizzle')")
    expect(sql).toContain('dsh_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS')
    expect(sql).not.toContain('REASSIGN OWNED')
    expect(sql).toContain('created_at = 1789689600000')
    expect(sql).toContain(createHash('sha256').update(baseline).digest('hex'))
    expect(sql).toContain('CREATEROLE NOBYPASSRLS')
  })

  it('does not reassign sequences owned by table columns', () => {
    const sql = readFileSync(bootstrapPath, 'utf8')
    expect(sql).toContain("relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')")
    expect(sql).toContain("relation.relkind <> 'S'")
    expect(sql).toContain("dependency.deptype IN ('a', 'i')")
    expect(sql).toContain('pg_depend')
  })

  it('ships an atomic worker claim for browser-created queued runs', () => {
    const sql = queueClaimSql()
    const journal = readFileSync(resolve(import.meta.dirname, '../migrations/meta/_journal.json'), 'utf8')
    expect(journal).toContain('0010_generation_queue_claim')
    expect(sql).toContain("run.agent_principal_id = 'user-request'")
    expect(sql).toContain("run.status = 'queued'")
    expect(sql).toContain('UPDATE ai.generation_runs')
    expect(sql).toContain('RETURNING id')
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION ai.claim_generation_run(UUID,UUID,UUID) FROM PUBLIC')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION ai.claim_generation_run(UUID,UUID,UUID) TO dsh_worker_runtime')
    expect(sql).toContain("OLD.agent_principal_id = 'user-request'")
    expect(sql).toContain('NEW.agent_principal_id = app.current_agent_principal_id()')
  })

  it('ships a follow-up RLS repair for databases that already applied the queue claim', () => {
    const sql = queueClaimHardeningSql()
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION app.agent_run_allowed(')
    const end = sql.indexOf('$$;', start)
    expect(sql).toContain('DROP POLICY ai_runs_worker_update ON ai.generation_runs')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION app.generation_run_claim_allowed(')
    expect(sql.slice(start, end)).not.toContain("run.status = 'queued' AND run.agent_principal_id = 'user-request'")
    expect(sql).toContain('app.generation_run_claim_allowed(workspace_id, novel_id, id)')
  })

  it('adds durable generation-context snapshot columns without rewriting old rows', () => {
    const migration = readFileSync(resolve(import.meta.dirname, '../migrations/0012_generation_context_snapshots.sql'), 'utf8')
    const migrationDirectory = resolve(import.meta.dirname, '../migrations')
    const journal = JSON.parse(readFileSync(resolve(migrationDirectory, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }
    const snapshot = JSON.parse(readFileSync(resolve(migrationDirectory, 'meta/0012_snapshot.json'), 'utf8')) as {
      id: string
      tables: Record<string, { columns: Record<string, unknown> }>
    }
    expect(journal.entries.at(-1)?.tag).toBe('0012_generation_context_snapshots')
    expect(snapshot.id).toBe('0012_generation_context_snapshots')
    expect(snapshot.tables['ai.generation_context_items']?.columns).toHaveProperty('excerpt')
    expect(snapshot.tables['ai.generation_context_items']?.columns).toHaveProperty('source_status')
    expect(migration).toContain('ADD COLUMN excerpt TEXT')
    expect(migration).toContain('ADD COLUMN source_status TEXT')
    expect(migration).toContain("source_status IN ('draft', 'published', 'archived', 'deleted')")
    expect(migration).toContain('(excerpt IS NULL) = (source_status IS NULL)')
    expect(migration).not.toMatch(/UPDATE\s+ai\.generation_context_items/iu)
  })

  it('keeps the durable generation lock and result writes on one transaction connection', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../storage/novel-authoring/src/result-repository.ts'), 'utf8')
    expect(source).toContain('AsyncLocalStorage')
    expect(source).toContain('pg_advisory_xact_lock')
    expect(source).toContain('drizzleFromPoolClient')
    expect(source).not.toContain('pg_advisory_lock(')
  })
})
