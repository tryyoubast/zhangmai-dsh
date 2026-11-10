import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { schemaMetadata } from './schema-metadata.ts'

describe('PostgreSQL Drizzle metadata', () => {
  it('preserves columns, defaults, indexes, and named constraints', () => {
    const expected: unknown = JSON.parse(readFileSync(new URL('./expected/schema-metadata.json', import.meta.url), 'utf8'))
    expect(JSON.parse(JSON.stringify(schemaMetadata()))).toEqual(expected)
  })
})
