/** Durable checkpoint synchronization for cache fixtures. */

import { expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { projectionCacheDomainSpec } from '../src/spec.ts'
import type { CheckpointRecord } from '../src/spec.ts'

/**
 * Subscribe before a mutation and wait for its matching durable checkpoint.
 * `domain/changed` follows the disk commit; opening the JSON only after this
 * barrier avoids blocking Windows atomic replacement with a polling reader.
 * @param ctx - context carrying storage-domain notifications.
 * @param id - session whose checkpoint must commit.
 * @param matches - distinguishes the requested cut from a creation checkpoint.
 * @param operation - mutation that schedules the checkpoint.
 * @returns the mutation's result after its checkpoint commits.
 */
export async function afterCheckpoint<T>(
  ctx: Context,
  id: SessionId,
  matches: (record: CheckpointRecord) => boolean,
  operation: () => T | Promise<T>,
): Promise<T> {
  let written = false
  const dispose = ctx.on('domain/changed', (change) => {
    if (change.domain !== projectionCacheDomainSpec.name || change.table !== 'sessions'
      || change.key !== id || change.operation !== 'put') return
    if (matches(change.value as CheckpointRecord)) written = true
  })
  try {
    const result = await operation()
    await vi.waitFor(() => {
      expect(written, `durable checkpoint for "${id}"`).toBe(true)
    }, { timeout: 5_000 })
    return result
  } finally {
    dispose()
  }
}
