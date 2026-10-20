import { describe, expect, it } from 'vitest'
import { fromDatabaseClientType, toDatabaseClientType } from '../src/postgres.ts'

describe('PostgreSQL session client type mapping', () => {
  it('maps public client types to the constrained database values', () => {
    expect(toDatabaseClientType('browser')).toBe('web')
    expect(toDatabaseClientType('official-client')).toBe('official_client')
    expect(fromDatabaseClientType('web')).toBe('browser')
    expect(fromDatabaseClientType('official_client')).toBe('official-client')
  })
})
