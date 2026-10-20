import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(resolve(import.meta.dirname, '../migrations/0005_longform_publication_hardening.sql'), 'utf8')

describe('long-form publication hardening migration', () => {
  it('binds every long-form proposal target to a same-workspace reference', () => {
    for (const target of ['outlines', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events']) {
      expect(migration).toContain(`WHEN '${target}'`)
    }
    expect(migration).toContain('entity_reference_exists')
    expect(migration).toContain('app.agent_run_allowed')
  })

  it('requires an approved matching proposal for long-form publication', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION novel.guard_longform_publication()')
    expect(migration).toContain("proposal.status = 'approved'")
    expect(migration).toContain('proposal.proposed_content = to_jsonb(OLD)')
    expect(migration).toContain('publishing long-form records requires the review service')
  })

  it('keeps chapter summaries idempotent and lifecycle-aware', () => {
    expect(migration).toContain('ADD COLUMN status TEXT NOT NULL DEFAULT')
    expect(migration).toContain('ADD COLUMN source_idempotency_key TEXT')
    expect(migration).toContain('chapter_summaries_workspace_idempotency_idx')
    expect(migration).toContain('novel_chapter_summaries_worker_draft_update')
  })

  it('does not grant protected helper functions to PUBLIC', () => {
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION novel.entity_reference_exists')
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION novel.guard_longform_publication() FROM PUBLIC')
  })
})
