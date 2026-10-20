import { describe, expect, it } from 'vitest'
import * as schema from '../src/schema.ts'

describe('novel authoring Drizzle schema', () => {
  it('exports each independently versioned draft entity', () => {
    for (const name of [
      'locations',
      'locationVersions',
      'factions',
      'factionVersions',
      'items',
      'itemVersions',
      'storylines',
      'storylineVersions',
      'entityRelationVersions',
    ]) {
      expect(schema).toHaveProperty(name)
    }
    expect(schema).toHaveProperty('characterSkillVersions')
  })

  it('exposes worker retry keys and check-constrained lifecycle fields', () => {
    expect(schema.characters).toBeDefined()
    expect(schema.generationRuns).toBeDefined()
    expect(schema.generationProposals).toBeDefined()
    expect(schema.entityRelations).toBeDefined()
  })

  it('models character-skill links as versioned draft records', () => {
    expect(schema.characterSkills).toHaveProperty('attributesJsonb')
    expect(schema.characterSkills).toHaveProperty('attributesSchemaVersion')
    expect(schema.characterSkills).toHaveProperty('currentVersionNo')
    expect(schema.characterSkillVersions).toBeDefined()
  })

  it('exposes long-form chapter, memory, and generation-context tables', () => {
    for (const name of [
      'outlines',
      'chapters',
      'chapterVersions',
      'chapterSummaries',
      'storyFacts',
      'timelineEvents',
      'generationContextItems',
    ]) {
      expect(schema).toHaveProperty(name)
    }
    expect(schema.chapterVersions).toHaveProperty('contentStorageKind')
    expect(schema.chapterVersions).toHaveProperty('contentObjectKey')
    expect(schema.generationContextItems).toHaveProperty('generationRunId')
  })
})
