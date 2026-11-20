/** Consume locator-only durable generation notifications, retaining recoverable failures. */
export interface GenerationLocator { readonly workspaceId: string; readonly generationRunId: string }
/** One Redis Stream delivery; fields remain untrusted until parsed. */
export interface QueueEntry { readonly id: string; readonly fields: readonly string[] }
/** Persisted status observed after resolving the delivery's current database authority. */
export interface QueueIdentity { readonly status: string }
/** Domain operations executed under freshly resolved persisted authority. */
export interface DeliveryOperations<Identity extends QueueIdentity> {
  resolve(locator: GenerationLocator): Promise<Identity | null>
  settleUnavailable(locator: GenerationLocator): Promise<'ack' | 'retain'>
  execute(locator: GenerationLocator, identity: Identity): Promise<unknown>
  interrupt(locator: GenerationLocator, identity: Identity): Promise<void>
}
/** Process-owned broker and delivery operations; each delivery settles before further intake. */
export interface ConsumerOperations {
  recover(): Promise<readonly QueueEntry[]>
  read(): Promise<readonly QueueEntry[]>
  ack(id: string): Promise<void>
  deliver(fields: readonly string[]): Promise<'ack' | 'retain'>
  pause(): Promise<void>
}
/**
 * Accept exactly two UUID locators; identity and provider settings come from trusted persistence.
 * @param fields - Untrusted alternating Redis field names and string values.
 * @returns Normalized locators, or null for any other field set.
 */
export function parseGenerationLocator(fields: readonly string[]): GenerationLocator | null {
  if (fields.length !== 4) return null
  const values = { workspaceId: '', generationRunId: '' }
  for (let index = 0; index < fields.length; index += 2) {
    const name = fields[index]
    const value = fields[index + 1]
    if ((name !== 'workspaceId' && name !== 'generationRunId') || values[name] !== '' || value === undefined
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) return null
    values[name] = value.toLowerCase()
  }
  // Four fields with two distinct permitted names establish both required values.
  return values
}

function terminal(identity: QueueIdentity): boolean {
  return ['completed', 'failed', 'cancelled'].includes(identity.status)
}

/**
 * Resolve live database authority on each delivery; database failures retain the pending notification.
 * @param fields - Untrusted alternating Redis field names and values.
 * @param operations - Persisted identity resolution and principal-bound generation operations.
 * @returns Whether the broker may acknowledge the delivery or must retain it for recovery.
 */
export async function deliverGeneration<I extends QueueIdentity>(fields: readonly string[], operations: DeliveryOperations<I>): Promise<'ack' | 'retain'> {
  const locator = parseGenerationLocator(fields)
  if (locator === null) return 'ack'
  try {
    const identity = await operations.resolve(locator)
    if (identity === null) return await operations.settleUnavailable(locator)
    if (terminal(identity)) return 'ack'
    if (identity.status === 'running') {
      await operations.interrupt(locator, identity)
      return 'ack'
    }
    try {
      await operations.execute(locator, identity)
      return 'ack'
    } catch {
      const settled = await operations.resolve(locator)
      if (settled === null) return await operations.settleUnavailable(locator)
      return terminal(settled) ? 'ack' : 'retain'
    }
  } catch {
    return 'retain'
  }
}

/** One process-owned, serial intake loop. The owner must hold the database worker lock until stop settles. */
export class SerialGenerationConsumer {
  private task: Promise<void> | undefined
  private stopped = false
  constructor(private readonly operations: ConsumerOperations) {}

  /** Start intake once; all broker failures remain inside the retry loop. */
  start(): void {
    if (this.task !== undefined) throw new Error('novel-host: consumer already started')
    this.task = this.run()
  }

  /** Stop intake and await the current delivery, including its acknowledgement attempt. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.task
  }

  private async run(): Promise<void> {
    while (!this.isStopped()) {
      try {
        const recovered = await this.operations.recover()
        const entries = recovered.length > 0 ? recovered : this.isStopped() ? [] : await this.operations.read()
        for (const entry of entries) {
          if (this.isStopped()) break
          if (await this.operations.deliver(entry.fields) === 'ack') await this.operations.ack(entry.id)
          else await this.operations.pause()
        }
      } catch {
        // A failed ACK remains in the PEL and is re-read before new deliveries.
        try { await this.operations.pause() } catch { /* Intake retries or stops after the owner cancels its delay. */ }
      }
    }
  }

  private isStopped(): boolean {
    return this.stopped
  }
}
