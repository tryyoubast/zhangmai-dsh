import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each([['reserve', 'invalid', 'invalid'], ['duplicate', 'invalid', 'invalid'], ['unsupported']])(
  'rejects unsafe broker operation %s before loading credentials or connecting', async (...args) => {
    const result: unknown = await execute(process.execPath, [resolve(import.meta.dirname, '../deploy/local-test/broker.mjs'), ...args])
      .catch((error: unknown) => error)
    if (!(result instanceof Error) || !('stderr' in result) || typeof result.stderr !== 'string') throw new Error('Expected broker validation failure')
    expect(result.stderr).toContain('Staging broker operation requires a supported action and UUID locators')
    expect(result.stderr).not.toContain('ENOENT')
  },
)
