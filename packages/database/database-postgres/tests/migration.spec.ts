import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = resolve(import.meta.dirname, '../migrations/0001_auth_workspace_novel_ai.sql')

function migrationSql(): string {
  return readFileSync(migrationPath, 'utf8')
}

describe('PostgreSQL foundation migration', () => {
  it('enables the extension required by UUID defaults before creating tables', () => {
    const sql = migrationSql()
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto;')
    expect(sql.indexOf('CREATE EXTENSION IF NOT EXISTS pgcrypto;')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS auth.users'),
    )
  })

  it('creates every application schema and required domain tables', () => {
    const sql = migrationSql()
    for (const schema of ['auth', 'app', 'novel', 'ai', 'security']) {
      expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    }
    for (const table of [
      'auth.users',
      'auth.sessions',
      'auth.refresh_tokens',
      'auth.email_verification_tokens',
      'auth.password_reset_tokens',
      'app.workspaces',
      'app.workspace_members',
      'novel.novels',
      'novel.characters',
      'novel.character_versions',
      'novel.skills',
      'novel.skill_versions',
      'novel.character_skills',
      'novel.entity_relations',
      'ai.generation_runs',
      'ai.generation_proposals',
      'security.audit_events',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')}`))
    }
  })

  it('defines runtime roles, revokes public DDL, and grants no publish path to workers', () => {
    const sql = migrationSql()
    for (const role of ['dsh_migrator', 'dsh_auth_runtime', 'dsh_app_runtime', 'dsh_worker_runtime', 'dsh_readonly']) {
      expect(sql).toContain(`rolname = '${role}'`)
    }
    expect(sql).toMatch(/REVOKE CREATE ON SCHEMA (auth|app|novel|ai|security) FROM PUBLIC/)
    expect(sql).toContain("status = 'draft'")
    expect(sql).not.toContain("status = 'published'")
    expect(sql).toContain('current_user')
  })

  it('enables RLS for every workspace-scoped table and stores token material as hashes', () => {
    const sql = migrationSql()
    for (const table of [
      'app.workspaces',
      'app.workspace_members',
      'novel.novels',
      'novel.characters',
      'novel.character_versions',
      'novel.skills',
      'novel.skill_versions',
      'novel.character_skills',
      'novel.entity_relations',
      'ai.generation_runs',
      'ai.generation_proposals',
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    }
    expect(sql).toMatch(/token_hash\s+TEXT\s+NOT NULL/)
    expect(sql).not.toMatch(/raw_token\s+TEXT/i)
    expect(sql).toMatch(/CREATE (?:OR REPLACE )?FUNCTION app\.workspace_access_allowed/)
  })

  it('retains the released baseline migration as an immutable predecessor', () => {
    const sql = migrationSql()
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS novel.characters')
    expect(sql).toContain('CREATE POLICY ai_proposals_worker_draft_create')
  })
})
