import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { describe, expect, it } from 'vitest'
import { resolveMigrationsDirectory } from '../src/database.ts'

describe('packaged draft guard privilege repair', () => {
  it.each([
    ['0018_draft_guard_context_privileges', '0017_generation_worker_identity'],
    ['0019_agent_run_predicate_privileges', '0018_draft_guard_context_privileges'],
  ])('loads %s and its checksum through the published migration directory', (tag, previousTag) => {
    const packageRoot = resolve(import.meta.dirname, '..')
    const directory = resolveMigrationsDirectory(pathToFileURL(resolve(packageRoot, 'lib/index.js')).href)
    const journal = JSON.parse(readFileSync(resolve(directory, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>
    }
    const repair = journal.entries.find(entry => entry.tag === tag)
    expect(repair).toBeDefined()
    if (repair === undefined) throw new Error('Draft guard repair is missing from the packaged journal')
    const predecessor = journal.entries[repair.idx - 1]
    expect(predecessor?.tag).toBe(previousTag)
    expect(repair.when).toBeGreaterThan(predecessor!.when)
    const source = readFileSync(resolve(directory, `${repair.tag}.sql`), 'utf8')
    const migrations = readMigrationFiles({ migrationsFolder: directory })
    expect(migrations).toHaveLength(journal.entries.length)
    expect(migrations[repair.idx]).toMatchObject({
      folderMillis: repair.when, hash: createHash('sha256').update(source).digest('hex'), sql: [source],
    })
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { files: string[] }
    expect(manifest.files).toContain('migrations/*.sql')
    expect(manifest.files).toContain('migrations/meta/_journal.json')
  })
})
