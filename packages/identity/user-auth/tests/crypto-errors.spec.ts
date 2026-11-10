import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

const password = 'a sufficiently long password'

describe('password primitive failures', () => {
  it('rejects hashing on a runtime without Argon2 rather than choosing a weaker algorithm', async () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)
    vi.resetModules()
    const auth = await import('../src/index.ts')
    await expect(auth.hashPassword(password)).rejects.toBeInstanceOf(auth.PasswordHashingUnavailableError)
  })

  it.each([new Error('native worker failed'), undefined])('propagates native Argon2 failure %s', async (failure) => {
    const original = process.getBuiltinModule.bind(process)
    const argon2 = (_algorithm: string, _parameters: unknown, callback: (error?: Error, digest?: Uint8Array) => void) => {
      callback(failure)
    }
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(id => id === 'node:crypto' ? { argon2 } : original(id))
    vi.resetModules()
    const auth = await import('../src/index.ts')
    await expect(auth.hashPassword(password)).rejects.toThrow(failure?.message ?? 'Argon2id failed')
  })

})
