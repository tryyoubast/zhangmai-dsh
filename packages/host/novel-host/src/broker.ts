/** Redis Stream commands use the maintained client; only PostgreSQL-backed locators cross this queue. */
import type { Redis } from 'ioredis'
import type { QueueEntry } from './queue.ts'
import type { Config } from './config.ts'

function entries(value: unknown): QueueEntry[] {
  if (!Array.isArray(value)) throw new Error('novel-host: invalid broker reply')
  return value.map((entry: unknown) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new Error('novel-host: invalid broker entry')
    const fields: unknown = entry[1]
    return { id: entry[0], fields: Array.isArray(fields) && fields.every(field => typeof field === 'string') ? fields : [] }
  })
}

/**
 * Create the group at the stream's beginning; existing groups keep their delivery position.
 * @param redis - Connected Redis command client.
 * @param config - Stream and consumer-group deployment settings.
 */
export async function ensureGroup(redis: Redis, config: Config['redis']): Promise<void> {
  try { await redis.call('XGROUP', 'CREATE', config.stream, config.group, '0', 'MKSTREAM') } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('BUSYGROUP ')) throw new Error('novel-host: queue group unavailable')
  }
}

/**
 * Serial COUNT 1 operations; recovery at idle zero requires the exclusive PostgreSQL worker lock.
 * @param redis - Connected Redis command client.
 * @param config - Stream, group, and blocking-read settings.
 * @param consumer - Unique name of the lock-owning process.
 * @returns Pending recovery, new-message intake, and acknowledgement operations.
 */
export function brokerIntake(redis: Redis, config: Config['redis'], consumer: string): {
  recover(): Promise<readonly QueueEntry[]>
  read(): Promise<readonly QueueEntry[]>
  ack(id: string): Promise<void>
} {
  let cursor = '0-0'
  return {
    async recover() {
      do {
        const reply: unknown = await redis.call('XAUTOCLAIM', config.stream, config.group, consumer, '0', cursor, 'COUNT', '1')
        if (!Array.isArray(reply) || typeof reply[0] !== 'string') throw new Error('novel-host: invalid broker recovery reply')
        cursor = reply[0]
        const recovered = entries(reply[1])
        if (recovered.length > 0) return recovered
      } while (cursor !== '0-0')
      return []
    },
    async read() {
      const reply: unknown = await redis.call('XREADGROUP', 'GROUP', config.group, consumer, 'COUNT', '1', 'BLOCK', String(config.blockMs), 'STREAMS', config.stream, '>')
      if (reply === null) return []
      if (!Array.isArray(reply) || !Array.isArray(reply[0])) throw new Error('novel-host: invalid broker read reply')
      return entries(reply[0][1])
    },
    async ack(id) { await redis.call('XACK', config.stream, config.group, id) },
  }
}
