import { describe, expect, it, vi } from 'vitest'
import { parseGenerationLocator, deliverGeneration, SerialGenerationConsumer } from '../src/queue.ts'

const locator = { workspaceId: '11111111-1111-4111-8111-111111111111', generationRunId: '22222222-2222-4222-8222-222222222222' }
const fields = Object.entries(locator).flat()

describe('generation queue authority', () => {
  it.each([
    [...fields, 'userId', 'forged'], [...fields, 'roles', 'owner'], [...fields, 'agentPrincipalId', 'forged'],
    ['workspaceId', 'invalid', 'generationRunId', locator.generationRunId], [...fields, 'workspaceId', locator.workspaceId],
    [...fields, 'extra'], [],
  ].map(value => [value]))('rejects invalid locator fields before identity resolution', async (value) => {
    expect(parseGenerationLocator(value)).toBeNull()
    const resolve = vi.fn()
    expect(await deliverGeneration(value, { resolve, settleUnavailable: vi.fn(), execute: vi.fn(), interrupt: vi.fn() })).toBe('ack')
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('acknowledges %s without executing the provider', async (status) => {
    const execute = vi.fn()
    expect(await deliverGeneration(fields, { resolve: async () => ({ status }), settleUnavailable: vi.fn(), execute, interrupt: vi.fn() })).toBe('ack')
    expect(execute).not.toHaveBeenCalled()
  })

  it('marks interrupted running work failed before acknowledgement', async () => {
    const interrupt = vi.fn(async () => {})
    const execute = vi.fn()
    expect(await deliverGeneration(fields, { resolve: async () => ({ status: 'running' }), settleUnavailable: vi.fn(), execute, interrupt })).toBe('ack')
    expect(interrupt).toHaveBeenCalledWith(locator, { status: 'running' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('retains failed database operations and does not automatically retry the provider', async () => {
    const execute = vi.fn(async () => { throw new Error('provider secret') })
    const resolve = vi.fn().mockResolvedValueOnce({ status: 'queued' }).mockResolvedValueOnce({ status: 'running' })
    expect(await deliverGeneration(fields, { resolve, settleUnavailable: vi.fn(), execute, interrupt: vi.fn() })).toBe('retain')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await deliverGeneration(fields, { resolve: async () => { throw new Error('db secret') }, settleUnavailable: vi.fn(), execute, interrupt: vi.fn() })).toBe('retain')
  })

  it('checks persisted terminal state after a provider failure before acknowledgement', async () => {
    const resolve = vi.fn().mockResolvedValueOnce({ status: 'queued' }).mockResolvedValueOnce({ status: 'failed' })
    expect(await deliverGeneration(fields, { resolve, settleUnavailable: vi.fn(), execute: async () => { throw new Error('provider') }, interrupt: vi.fn() })).toBe('ack')
  })

  it('retains a delivery when settlement finds usable authority again', async () => {
    const execute = vi.fn(async () => {})
    const settleUnavailable = vi.fn(async () => 'retain' as const)
    const resolve = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'queued' })
    const operations = { resolve, settleUnavailable, execute, interrupt: vi.fn() }
    expect(await deliverGeneration(fields, operations)).toBe('retain')
    expect(settleUnavailable).toHaveBeenCalledWith(locator)
    expect(execute).not.toHaveBeenCalled()
    expect(await deliverGeneration(fields, operations)).toBe('ack')
    expect(execute).toHaveBeenCalledWith(locator, { status: 'queued' })
    await expect(deliverGeneration(fields, {
      resolve: async () => null, settleUnavailable: async () => { throw new Error('db secret') },
      execute, interrupt: vi.fn(),
    })).resolves.toBe('retain')
    expect(parseGenerationLocator(['workspaceId', locator.workspaceId, 'workspaceId', locator.workspaceId])).toBeNull()
    expect(parseGenerationLocator(['unexpected', locator.workspaceId, 'generationRunId', locator.generationRunId])).toBeNull()
  })

  it('settles a delivery when its authority disappears during execution', async () => {
    const resolve = vi.fn().mockResolvedValueOnce({ status: 'queued' }).mockResolvedValueOnce(null)
    const settleUnavailable = vi.fn(async () => 'ack' as const)
    const execute = vi.fn(async () => { throw new Error('execution failed') })
    expect(await deliverGeneration(fields, { resolve, settleUnavailable, execute, interrupt: vi.fn() })).toBe('ack')
    expect(settleUnavailable).toHaveBeenCalledWith(locator)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('retries broker failure and retains unacknowledged work before accepting new entries', async () => {
    const calls: string[] = []
    let recoveries = 0
    const consumer = new SerialGenerationConsumer({
      recover: async () => {
        recoveries++
        if (recoveries === 1) throw new Error('broker offline')
        return recoveries < 4 ? [{ id: '1-0', fields }] : []
      },
      read: async () => { calls.push('read'); void consumer.stop(); return [{ id: 'new', fields }] },
      ack: async () => { calls.push('ack'); throw new Error('ack offline') },
      deliver: async () => { calls.push('deliver'); return recoveries === 2 ? 'retain' : 'ack' },
      pause: async () => { calls.push('pause'); if (recoveries === 1) throw new Error('cancelled delay') },
    })
    consumer.start()
    expect(() => { consumer.start() }).toThrow('already started')
    await vi.waitFor(() => { expect(calls).toContain('read') })
    await consumer.stop()
    expect(calls).toEqual(['pause', 'deliver', 'pause', 'deliver', 'ack', 'pause', 'read'])
  })

  it('stops after recovery settles without reading or delivering newly recovered work', async () => {
    let release!: (entries: []) => void
    const recover = new Promise<[]>((resolve) => { release = resolve })
    const read = vi.fn()
    const consumer = new SerialGenerationConsumer({ recover: () => recover, read, ack: vi.fn(), deliver: vi.fn(), pause: vi.fn() })
    consumer.start()
    const stopped = consumer.stop()
    release([])
    await stopped
    expect(read).not.toHaveBeenCalled()
  })

  it('recovers pending entries before new entries and waits for in-flight work during teardown', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const consumer = new SerialGenerationConsumer({
      recover: async () => { calls.push('recover'); return [{ id: '1-0', fields }] },
      read: async () => { calls.push('read'); return [] },
      ack: async (id) => { calls.push(`ack:${id}`) },
      deliver: async () => { calls.push('deliver'); await held; return 'ack' },
      pause: async () => {},
    })
    consumer.start()
    await vi.waitFor(() => { expect(calls).toContain('deliver') })
    const closed = consumer.stop().then(() => { calls.push('closed') })
    await Promise.resolve()
    expect(calls).toEqual(['recover', 'deliver'])
    release()
    await closed
    expect(calls).toEqual(['recover', 'deliver', 'ack:1-0', 'closed'])
  })
})
