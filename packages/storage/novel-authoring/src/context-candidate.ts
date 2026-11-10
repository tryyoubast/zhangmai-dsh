/** Map validated durable context excerpts without reading mutable source entities. */
import type { ContextCandidate } from './index.ts'
import type { PersistedGenerationContextItem } from './generation.ts'

/**
 * Restore the shared ranking inputs from a validated persisted selection.
 * @param item - Saved selection whose excerpt and source status have been validated.
 * @returns A candidate preserving the saved text, provenance, and token count.
 */
export function persistedContextCandidate(
  item: Pick<PersistedGenerationContextItem, 'sourceType' | 'sourceId' | 'workspaceId' | 'novelId'
    | 'excerptHash' | 'tokenCount' | 'selectionReason'> & { excerpt: string; sourceStatus: ContextCandidate['status'] },
): ContextCandidate {
  return {
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    workspaceId: item.workspaceId,
    novelId: item.novelId,
    status: item.sourceStatus,
    relevanceScore: 0,
    recencyScore: 0,
    excerptHash: item.excerptHash,
    excerpt: item.excerpt,
    tokenCount: item.tokenCount,
    selectionReason: item.selectionReason,
  }
}
