import { describe, expect, it, vi } from 'vitest'
import { checkReadiness, selectProviderKey, identityForRequest } from '../src/boundaries.ts'

describe('host authority and dependency boundaries', () => {
  it('onboards only login and resolves ordinary reads with a selection hint', async () => {
    const identity = { userId: 'u', workspaceId: 'w', roles: ['owner'] as const }
    const resolver = {
      onboard: vi.fn(async () => identity), resolve: vi.fn(async () => identity),
      resolveForCredentials: vi.fn(async () => identity),
    }
    await identityForRequest(resolver, { method: 'POST', path: '/api/auth/login', headers: {} })('u', 's')
    expect(resolver.onboard).toHaveBeenCalledWith('u')
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(resolver.resolveForCredentials).not.toHaveBeenCalled()
    for (const path of ['/api/auth/me', '/api/novels/n/generate']) {
      await identityForRequest(resolver, { method: 'POST', path, headers: { 'x-dsh-workspace-id': 'choice', roles: 'owner' } })('u', 's')
    }
    await identityForRequest(resolver, { method: 'POST', path: '/api/auth/refresh', headers: { 'x-dsh-workspace-id': 'choice' } })('u', 's')
    expect(resolver.onboard).toHaveBeenCalledTimes(1)
    expect(resolver.resolve.mock.calls).toEqual([['u', 'choice'], ['u', 'choice']])
    expect(resolver.resolveForCredentials.mock.calls).toEqual([['u', 'choice']])
  })

  it('keeps populated real credentials away from the fixed fixture endpoint', () => {
    expect(selectProviderKey('http://model:8081/v1', 'real-secret')).toBe('fixture-only')
    expect(selectProviderKey('https://api.deepseek.com/v1', 'real-secret')).toBe('real-secret')
    expect(() => selectProviderKey('https://api.deepseek.com/v1', '')).toThrow('novel-host: provider key is required')
    expect(() => selectProviderKey('http://other:8081/v1', '')).toThrow()
  })

  it.each(['database', 'redis', 'smtp'])('reports %s readiness failures without leaking dependency errors', async (failure) => {
    const checks = Object.fromEntries(['database', 'redis', 'smtp'].map(name => [name, async () => {
      if (name === failure) throw new Error('password=secret')
    }]))
    expect(await checkReadiness(checks)).toEqual({ ready: false })
  })

  it('waits for all readiness checks and never invokes a model', async () => {
    const calls: string[] = []
    expect(await checkReadiness({
      roles: async () => { calls.push('roles') }, schema: async () => { calls.push('schema') },
      redis: async () => { calls.push('redis') }, smtp: async () => { calls.push('smtp') },
    })).toEqual({ ready: true })
    expect(calls.sort()).toEqual(['redis', 'roles', 'schema', 'smtp'])
  })
})
