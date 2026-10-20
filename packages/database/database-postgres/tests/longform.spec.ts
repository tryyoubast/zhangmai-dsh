import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const migrationPath = resolve(packageRoot, 'migrations/0004_novel_longform_context.sql')

function migrationSql(): string {
  return readFileSync(migrationPath, 'utf8')
}

describe('long-form novel persistence migration', () => {
  it('defines durable chapter and context tables', () => {
    const sql = migrationSql()
    expect(sql).toContain("'chapter_versions'")
    expect(sql).toContain("'story_facts'")
    for (const table of [
      'novel.outlines',
      'novel.chapters',
      'novel.chapter_versions',
      'novel.chapter_summaries',
      'novel.story_facts',
      'novel.timeline_events',
      'ai.generation_context_items',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`)
    }
    expect(sql).toContain('content_sha256')
    expect(sql).toContain('content_storage_kind')
    expect(sql).toContain('content_object_key')
    expect(sql).toContain('generation_context_items_generation_run_fkey')
    const queueSql = readFileSync(resolve(packageRoot, 'migrations/0009_generation_queue_payload.sql'), 'utf8')
    expect(queueSql).toContain('instruction TEXT NOT NULL')
    expect(queueSql).toContain('context_limit INTEGER NOT NULL')
  })

  it('protects long-form tables with workspace RLS and worker draft policies', () => {
    const sql = migrationSql()
    for (const table of [
      'outlines',
      'chapters',
      'chapter_versions',
      'chapter_summaries',
      'story_facts',
      'timeline_events',
    ]) {
      expect(sql).toContain(`ALTER TABLE novel.${table} ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`novel_${table}_worker_draft_insert`)
    }
    expect(sql).toContain('ai_generation_context_items_worker_insert')
    expect(sql).toContain("status = 'draft'")
    expect(sql).toContain('app.agent_run_allowed')
    for (const table of ['outlines', 'chapters', 'chapter_versions', 'story_facts', 'timeline_events']) {
      expect(sql).toContain(`novel_${table}_service_publish`)
    }
  })

  it('enforces object-storage rules for chapters larger than one mebibyte', () => {
    const sql = migrationSql()
    expect(sql).toContain("content_storage_kind IN ('postgres_text', 'object_storage')")
    expect(sql).toContain('content_bytes <= 1048576')
    expect(sql).toContain('content_text IS NOT NULL')
    expect(sql).toContain('content_object_key IS NOT NULL')
  })

  it('records the migration in the Drizzle journal', () => {
    const journal = JSON.parse(readFileSync(resolve(packageRoot, 'migrations/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    expect(journal.entries.some(entry => entry.tag === '0012_generation_context_snapshots')).toBe(true)
    expect(journal.entries.at(-1)?.tag).toBe('0013_legacy_context_rerun_marker')
  })

  it('keeps composite chapter references enforceable', () => {
    expect(migrationSql()).toContain('chapters_workspace_novel_id_key UNIQUE (workspace_id, novel_id, id)')
    const schema = readFileSync(resolve(import.meta.dirname, '../src/schema.ts'), 'utf8')
    expect(schema).toContain('chapters_workspace_novel_id_key')
  })
})
