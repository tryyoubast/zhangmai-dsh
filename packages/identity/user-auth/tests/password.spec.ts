import { describe, expect, it } from 'vitest'
import {
  ARGON2ID_PARAMETERS,
  createOpaqueToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from '../src/index.ts'
import { canPerform, type AuthPrincipal } from '../src/index.ts'

describe('user authentication primitives', () => {
  it('hashes and verifies passwords with independent salts', async () => {
    const first = await hashPassword('a sufficiently long password')
    const second = await hashPassword('a sufficiently long password')
    expect(first).not.toBe(second)
    expect(first).toContain(`m=${String(ARGON2ID_PARAMETERS.memoryKiB)},t=${String(ARGON2ID_PARAMETERS.timeCost)},p=${String(ARGON2ID_PARAMETERS.parallelism)}`)
    await expect(verifyPassword('a sufficiently long password', first)).resolves.toBe(true)
    await expect(verifyPassword('a different password', first)).resolves.toBe(false)
  })

  it('normalizes valid emails and rejects malformed addresses', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com')
    expect(() => normalizeEmail('not-an-email')).toThrow('Invalid email address')
  })

  it('enforces minimum password length and rejects common passwords', () => {
    expect(() => validatePassword('short')).toThrow('at least 12')
    expect(() => validatePassword('passwordpassword')).toThrow('too common')
  })

  it('creates opaque tokens and only persists their one-way digest', () => {
    const token = createOpaqueToken()
    expect(token.length).toBeGreaterThan(40)
    expect(hashToken(token)).not.toContain(token)
    expect(() => createOpaqueToken(16)).toThrow('between 32 and 128')
  })

  it('applies workspace roles without trusting client-provided role strings', () => {
    const principal: AuthPrincipal = {
      userId: 'user-1',
      sessionId: 'session-1',
      clientType: 'browser',
      workspaceId: 'workspace-1',
      roles: ['editor'],
      actorType: 'user',
    }
    expect(canPerform(principal, 'draft:create')).toBe(true)
    expect(canPerform(principal, 'proposal:publish')).toBe(false)
    expect(canPerform({ ...principal, roles: ['owner'] }, 'proposal:publish')).toBe(true)
  })
})
