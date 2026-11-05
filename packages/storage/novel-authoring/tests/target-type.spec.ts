import { describe, expect, it } from 'vitest'
import { isNovelDraftTargetType } from '../src/index.ts'

describe('isNovelDraftTargetType', () => {
  it.each(['outlines', 'characters', 'skills', 'locations', 'factions', 'items', 'storylines', 'entity_relations', 'character_skills', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events'])('accepts the supported target %s', (value) => {
    expect(isNovelDraftTargetType(value)).toBe(true)
  })

  it.each([undefined, null, '', ' ', 'unsupported', 'constructor', 'toString', '__proto__', 42, {}, [], true])('rejects unknown target %j', (value) => {
    expect(isNovelDraftTargetType(value)).toBe(false)
  })
})
