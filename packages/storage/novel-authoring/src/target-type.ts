/** Validate draft target names received from provider output and HTTP requests. */
import type { NovelDraftTargetType } from './index.ts'

const draftTargetTypes = {
  outlines: true,
  characters: true,
  skills: true,
  locations: true,
  factions: true,
  items: true,
  storylines: true,
  entity_relations: true,
  character_skills: true,
  chapters: true,
  chapter_versions: true,
  chapter_summaries: true,
  story_facts: true,
  timeline_events: true,
} satisfies Record<NovelDraftTargetType, true>

/**
 * Recognize the fixed target names supported by draft writers.
 * @param value - Untrusted target name from structured provider output or JSON requests.
 * @returns Whether the value names a supported draft target.
 */
export function isNovelDraftTargetType(value: unknown): value is NovelDraftTargetType {
  return typeof value === 'string' && Object.hasOwn(draftTargetTypes, value)
}
