import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(resolve(import.meta.dirname, '../migrations/0006_publication_and_rollback.sql'), 'utf8')
const rollbackMigration = readFileSync(resolve(import.meta.dirname, '../migrations/0007_secure_rollback.sql'), 'utf8')

describe('publication and rollback transaction migration', () => {
  it('restricts publication to the trusted service role and locks the proposal and target', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION ai.publish_generation_proposal')
    expect(migration).toContain("current_user <> 'dsh_service_runtime'")
    expect(migration).toContain('FOR UPDATE')
    expect(migration).toContain("status = 'published'")
    expect(migration).toContain('ai_proposal_published')
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION ai.publish_generation_proposal')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION ai.publish_generation_proposal(UUID, UUID) TO dsh_service_runtime')
  })

  it('moves rollback to a versioned migration without SECURITY DEFINER', () => {
    expect(rollbackMigration).toContain('CREATE OR REPLACE FUNCTION ai.rollback_entity_version')
    expect(rollbackMigration).toContain('SECURITY INVOKER')
    expect(rollbackMigration).not.toMatch(/rollback_entity_version[\s\S]*?SECURITY DEFINER/)
    expect(rollbackMigration).toContain("current_user <> 'dsh_service_runtime'")
    expect(rollbackMigration).toContain("app.current_actor_type() <> 'user'")
    expect(rollbackMigration).toContain('app.current_workspace_id() IS DISTINCT FROM requested_workspace_id')
    expect(rollbackMigration).toContain('app.current_user_id() IS NULL')
    expect(rollbackMigration).toContain('unsupported rollback target type')
    expect(rollbackMigration).toContain('novel_entity_rolled_back')
  })

  it('creates a new monotonically increasing version in a controlled rollback context', () => {
    expect(rollbackMigration).toContain("set_config('app.rollback_context'")
    expect(rollbackMigration).toContain("current_setting('app.rollback_context', true)")
    expect(rollbackMigration).toContain('next_version := current_version + 1')
    expect(rollbackMigration).toContain("'previous_version_no', current_version")
    expect(rollbackMigration).toContain("'version_no', next_version")
  })

  it('keeps rollback execution private to the service role', () => {
    expect(rollbackMigration).toContain('REVOKE EXECUTE ON FUNCTION ai.rollback_entity_version')
    expect(rollbackMigration).toContain('GRANT EXECUTE ON FUNCTION ai.rollback_entity_version(UUID, TEXT, UUID, INTEGER) TO dsh_service_runtime')
  })
})
