import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const lookupTag = '0015_current_user_workspace_memberships'
const claimTag = '0016_generation_claim_policy_repair'

describe('append-only staging identity and claim migrations', () => {
  it('appends a current-user-only membership lookup with app-only execution', () => {
    const path = resolve(root, `migrations/${lookupTag}.sql`)
    expect(existsSync(path)).toBe(true)
    const source = readFileSync(path, 'utf8')
    expect(source).toMatch(/FUNCTION app\.current_user_workspace_memberships\(\)/u)
    expect(source).toContain('app.current_user_id()')
    expect(source).toContain('member.revoked_at')
    expect(source).toContain('workspace.status')
    expect(source).toContain('SECURITY DEFINER')
    expect(source).toContain('SET search_path = pg_catalog, app')
    expect(source).toContain('OWNER TO dsh_migrator')
    expect(source).toContain('REVOKE ALL ON FUNCTION app.current_user_workspace_memberships() FROM PUBLIC')
    expect(source).toContain('GRANT EXECUTE ON FUNCTION app.current_user_workspace_memberships() TO dsh_app_runtime')
    expect(source).not.toMatch(/CREATE (?:TABLE|INDEX)|ALTER TABLE/u)
  })

  it('packages both appended entries and confines the claim repair to its approved policies', () => {
    const path = resolve(root, `migrations/${claimTag}.sql`)
    expect(existsSync(path)).toBe(true)
    const source = readFileSync(path, 'utf8')
    expect(source.slice(source.indexOf('DROP POLICY'))).toBe(`DROP POLICY IF EXISTS ai_runs_worker_claim_read ON ai.generation_runs;
CREATE POLICY ai_runs_worker_claim_read ON ai.generation_runs FOR SELECT TO dsh_worker_runtime
USING (app.generation_run_claim_allowed(workspace_id, novel_id, id));

DROP POLICY ai_runs_worker_update ON ai.generation_runs;
CREATE POLICY ai_runs_worker_update ON ai.generation_runs FOR UPDATE TO dsh_worker_runtime
USING (
  status IN ('queued', 'running')
  AND (app.agent_run_allowed(workspace_id, novel_id, id)
    OR app.generation_run_claim_allowed(workspace_id, novel_id, id))
)
WITH CHECK (
  (status IN ('running', 'completed', 'failed', 'cancelled')
    AND app.agent_run_allowed(workspace_id, novel_id, id))
  OR (status = 'queued' AND agent_principal_id = app.current_agent_principal_id()
    AND (app.agent_run_allowed(workspace_id, novel_id, id)
      OR app.generation_run_claim_allowed(workspace_id, novel_id, id)))
);
`)
    const journal = JSON.parse(readFileSync(resolve(root, 'migrations/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }
    expect(journal.entries.slice(14, 22).map(entry => entry.tag)).toEqual([
      lookupTag, claimTag, '0017_generation_worker_identity', '0018_draft_guard_context_privileges',
      '0019_agent_run_predicate_privileges', '0020_independent_proposal_publication',
      '0021_settle_unavailable_generation_runs', '0022_guard_proposal_publication_state',
    ])
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { files: string[] }
    expect(manifest.files).toContain('migrations/*.sql')
  })

  it('limits unavailable-run settlement to the checked worker context and exact task locators', () => {
    const source = readFileSync(resolve(root, 'migrations/0021_settle_unavailable_generation_runs.sql'), 'utf8')
    expect(source).toContain('SECURITY DEFINER')
    expect(source).toContain('SET search_path = pg_catalog, ai, app')
    expect(source).toContain('OWNER TO dsh_migrator')
    expect(source).toContain('REVOKE ALL ON FUNCTION ai.settle_generation_run_without_authority(UUID, UUID) FROM PUBLIC')
    expect(source).toContain('GRANT EXECUTE ON FUNCTION ai.settle_generation_run_without_authority(UUID, UUID) TO dsh_worker_runtime')
    expect(source).toContain('FOR NO KEY UPDATE')
    expect(source).toContain('ai.resolve_generation_run_worker_identity(requested_workspace_id, requested_run_id)')
    expect(source).toContain('GENERATION_AUTHORITY_UNAVAILABLE')
    expect(source).not.toMatch(/CREATE\s+(?:TABLE|INDEX)|GRANT\s+[^;]*ON\s+ai\.generation_runs/iu)
  })

  it('requires the published proposal target and exact candidate before its status audit', () => {
    const source = readFileSync(resolve(root, 'migrations/0022_guard_proposal_publication_state.sql'), 'utf8')
    expect(source).toContain('BEFORE UPDATE OF status ON ai.generation_proposals')
    expect(source).toContain('novel.approved_version_exists')
    expect(source).toContain('novel.entity_payload_matches')
    expect(source).toContain('SET search_path = pg_catalog, ai, novel, app')
    expect(source).toContain('SECURITY INVOKER')
    expect(source).not.toMatch(/CREATE\s+(?:TABLE|INDEX)|GRANT\s+[^;]*ON\s+ai\.generation_proposals/iu)
  })
})
