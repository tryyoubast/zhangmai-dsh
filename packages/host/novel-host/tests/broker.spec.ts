import { describe, expect, it, vi } from 'vitest'
import type { Redis } from 'ioredis'
import { brokerIntake, ensureGroup } from '../src/broker.ts'
import { config } from './config-fixture.ts'

const settings = config('unused').redis
const client = (call: ReturnType<typeof vi.fn>): Redis => ({ call }) as unknown as Redis

describe('Redis generation stream protocol', () => {
  it('creates a stream group at the beginning and preserves an existing group', async () => {
    const call = vi.fn().mockResolvedValue('OK')
    await ensureGroup(client(call), settings)
    expect(call).toHaveBeenCalledWith('XGROUP', 'CREATE', settings.stream, settings.group, '0', 'MKSTREAM')
    call.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'))
    await expect(ensureGroup(client(call), settings)).resolves.toBeUndefined()
  })

  it.each([new Error('private Redis password'), 'BUSYGROUP unsafe'])('redacts group creation failure', async (error) => {
    await expect(ensureGroup(client(vi.fn().mockRejectedValue(error)), settings)).rejects.toThrow('novel-host: queue group unavailable')
  })

  it('scans pending cursors before new messages and acknowledges only the delivery ID', async () => {
    const call = vi.fn().mockResolvedValueOnce(['7-0', [], []]).mockResolvedValueOnce(['0-0', [['1-0', ['workspaceId', 'one']]], []])
      .mockResolvedValueOnce([[settings.stream, [['2-0', ['generationRunId', 'two']]]]])
      .mockResolvedValueOnce(null).mockResolvedValueOnce('OK')
    const broker = brokerIntake(client(call), settings, 'worker')
    expect(await broker.recover()).toEqual([{ id: '1-0', fields: ['workspaceId', 'one'] }])
    expect(call.mock.calls.slice(0, 2)).toEqual([
      ['XAUTOCLAIM', settings.stream, settings.group, 'worker', '0', '0-0', 'COUNT', '1'],
      ['XAUTOCLAIM', settings.stream, settings.group, 'worker', '0', '7-0', 'COUNT', '1'],
    ])
    expect(await broker.read()).toEqual([{ id: '2-0', fields: ['generationRunId', 'two'] }])
    expect(await broker.read()).toEqual([])
    await broker.ack('2-0')
    expect(call).toHaveBeenLastCalledWith('XACK', settings.stream, settings.group, '2-0')
  })

  it.each([null, [], [7, []], ['0-0', null], ['0-0', [null]], ['0-0', [[7, []]]]])('rejects malformed recovery replies', async (reply) => {
    await expect(brokerIntake(client(vi.fn().mockResolvedValue(reply)), settings, 'w').recover()).rejects.toThrow(/invalid broker/u)
  })

  it.each([{}, [], [null], [[settings.stream, null]]])('rejects malformed new-message replies', async (reply) => {
    await expect(brokerIntake(client(vi.fn().mockResolvedValue(reply)), settings, 'w').read()).rejects.toThrow(/invalid broker/u)
  })

  it.each([null, ['field', 7]])('passes malformed entry fields as an invalid locator', async (fields) => {
    const broker = brokerIntake(client(vi.fn().mockResolvedValue(['0-0', [['1-0', fields]], []])), settings, 'w')
    expect(await broker.recover()).toEqual([{ id: '1-0', fields: [] }])
  })
})
