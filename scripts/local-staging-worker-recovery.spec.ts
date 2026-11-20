import { describe, expect, it, vi } from 'vitest'
import { interruptWorkerAfter, restoreFixedModelWorker, stagingProviderEnvironment } from '../deploy/local-test/acceptance-worker.ts'

describe('staging worker recovery', () => {
  it('prevents inherited real provider settings from changing subsequent mock restarts', () => {
    expect(stagingProviderEnvironment({ DSH_NOVEL_PROVIDER_URL: 'https://api.deepseek.com/v1', PATH: 'keep-path' }))
      .toEqual({ DSH_NOVEL_PROVIDER_URL: 'http://model:8081/v1', PATH: 'keep-path' })
    expect(stagingProviderEnvironment({}, { DSH_NOVEL_PROVIDER_URL: 'https://api.deepseek.com/v1' }))
      .toEqual({ DSH_NOVEL_PROVIDER_URL: 'https://api.deepseek.com/v1' })
  })
  it('selects the internal model explicitly when restoring the mock worker', async () => {
    const compose = vi.fn(async (_args: string[], _environment?: NodeJS.ProcessEnv) => '')
    await restoreFixedModelWorker(compose)
    expect(compose).toHaveBeenCalledExactlyOnceWith(
      ['up', '--detach', '--no-deps', '--force-recreate', 'worker'],
      { DSH_NOVEL_PROVIDER_URL: 'http://model:8081/v1' },
    )
  })

  it.each([false, true])('kills and restarts held work when the running check fails: %s', async (checkFails) => {
    const order: string[] = []
    const compose = vi.fn(async (args: string[]) => { order.push(args[0] ?? ''); return '' })
    const check = async () => {
      order.push('check')
      if (checkFails) throw new Error('running check timed out')
    }
    const result = interruptWorkerAfter(compose, check)
    if (checkFails) await expect(result).rejects.toThrow('running check timed out')
    else await expect(result).resolves.toBeUndefined()
    expect(order).toEqual(['check', 'kill', 'up'])
    expect(compose).toHaveBeenNthCalledWith(1, ['kill', '--signal', 'SIGKILL', 'worker'])
    expect(compose).toHaveBeenNthCalledWith(2, ['up', '--detach', '--no-deps', 'worker'])
  })

  it('attempts to start the worker even if the kill command fails', async () => {
    const compose = vi.fn(async (args: string[]) => {
      if (args[0] === 'kill') throw new Error('worker already stopped')
      return ''
    })
    await expect(interruptWorkerAfter(compose, async () => {})).rejects.toThrow('worker already stopped')
    expect(compose).toHaveBeenLastCalledWith(['up', '--detach', '--no-deps', 'worker'])
  })
})
