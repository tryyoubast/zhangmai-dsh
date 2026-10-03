import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const schemaSource = readFileSync(resolve(packageRoot, 'src/schema.ts'), 'utf8')
const journal = JSON.parse(readFileSync(resolve(packageRoot, 'migrations/meta/_journal.json'), 'utf8')) as {
  entries: Array<{ tag: string }>
}

describe('database index footprint', () => {
  it('removes indexes covered by required composite keys', () => {
    expect(schemaSource).not.toContain("index('novels_workspace_idx')")
    expect(schemaSource).not.toContain("index('characters_workspace_novel_idx')")
    expect(schemaSource).not.toContain("index('skills_workspace_novel_idx')")
    expect(schemaSource).not.toContain("index('character_skills_workspace_idx')")
  })

  it('ships a follow-up migration for databases that already applied the baseline', () => {
    expect(journal.entries.map(entry => entry.tag)).toContain('0003_remove_redundant_prefix_indexes')
    const migrationPath = resolve(packageRoot, 'migrations/0003_remove_redundant_prefix_indexes.sql')
    expect(existsSync(migrationPath)).toBe(true)
    const migration = readFileSync(migrationPath, 'utf8')
    for (const indexName of [
      'novel_novels_workspace_idx',
      'novel_characters_workspace_novel_idx',
      'novel_skills_workspace_novel_idx',
      'novel_character_skills_workspace_idx',
    ]) {
      expect(migration).toContain(`DROP INDEX IF EXISTS novel.${indexName}`)
    }
  })
})
