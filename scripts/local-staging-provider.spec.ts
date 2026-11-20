import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const script = resolve(import.meta.dirname, '../deploy/local-test/provider-check.mjs')
const secret = 'provider-key-must-never-appear-in-output'

interface CheckResult {
  ok: boolean
  reason: string
  status: number | null
  modelPresent: boolean | null
}

interface ProviderModule {
  checkProvider: (options: {
    secretFile: string
    model?: string
    fetch?: typeof fetch
    timeoutMs?: number
  }) => Promise<CheckResult>
}

async function checker(): Promise<ProviderModule['checkProvider']> {
  expect(existsSync(script), 'provider preflight script exists').toBe(true)
  const module = await import(pathToFileURL(script).href) as unknown as ProviderModule
  return module.checkProvider
}

async function withKey<T>(value: string | undefined, run: (file: string, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-check-'))
  try {
    const file = join(directory, 'deepseek-api-key')
    if (value !== undefined) await writeFile(file, value)
    return await run(file, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('local staging provider credential preflight', () => {
  it('checks the official catalogue with the same trimmed secret and configured model', async () => {
    const check = await checker()
    await withKey(`  ${secret}\n`, async (secretFile) => {
      const request: typeof fetch = async (url, options) => {
        expect(url).toBe('https://api.deepseek.com/v1/models')
        expect(options?.headers).toEqual({ Authorization: `Bearer ${secret}` })
        expect(options?.redirect).toBe('error')
        expect(options?.signal).toBeInstanceOf(AbortSignal)
        return Response.json({ data: [{ id: 'deepseek-reasoner' }] })
      }
      expect(await check({ secretFile, model: 'deepseek-reasoner', fetch: request })).toEqual({
        ok: true, reason: 'passed', status: 200, modelPresent: true,
      })
    })
  })

  it.each([undefined, '', ' \n\t'])('rejects missing or empty key %j before requesting a provider', async (value) => {
    const check = await checker()
    await withKey(value, async (secretFile) => {
      const request: typeof fetch = () => { throw new Error('Provider must not be called') }
      const result = await check({ secretFile, fetch: request })
      expect(result).toEqual({ ok: false, reason: value === undefined ? 'key-unavailable' : 'key-empty', status: null, modelPresent: null })
    })
  })

  it.each([401, 201, 500])('rejects HTTP %s without reading or exposing the response', async (status) => {
    const check = await checker()
    await withKey(secret, async (secretFile) => {
      const request: typeof fetch = async () => new Response(`raw provider response ${secret}`, { status })
      expect(await check({ secretFile, fetch: request })).toEqual({ ok: false, reason: 'http-status', status, modelPresent: null })
    })
  })

  it.each([null, {}, { data: 'invalid' }, { data: [null] }, { data: [{ id: 1 }] }])('rejects an invalid catalogue %j', async (catalogue) => {
    const check = await checker()
    await withKey(secret, async (secretFile) => {
      const request: typeof fetch = async () => Response.json(catalogue)
      expect(await check({ secretFile, fetch: request })).toEqual({ ok: false, reason: 'invalid-catalogue', status: 200, modelPresent: null })
    })
  })

  it('rejects invalid JSON without exposing the raw response', async () => {
    const check = await checker()
    await withKey(secret, async (secretFile) => {
      const request: typeof fetch = async () => new Response(`raw response ${secret}`)
      expect(await check({ secretFile, fetch: request })).toEqual({ ok: false, reason: 'invalid-catalogue', status: 200, modelPresent: null })
    })
  })

  it('requires deepseek-chat by default even when the catalogue is otherwise valid', async () => {
    const check = await checker()
    await withKey(secret, async (secretFile) => {
      const request: typeof fetch = async () => Response.json({ data: [{ id: 'other-model' }] })
      expect(await check({ secretFile, fetch: request })).toEqual({ ok: false, reason: 'model-missing', status: 200, modelPresent: false })
    })
  })

  it('reports network failures without exposing the exception or key', async () => {
    const check = await checker()
    await withKey(secret, async (secretFile) => {
      const request: typeof fetch = () => { throw new Error(`network cause ${secret}`) }
      expect(await check({ secretFile, fetch: request })).toEqual({ ok: false, reason: 'request-failed', status: null, modelPresent: null })
    })
  })

  it('aborts a stalled provider request at the deadline', async () => {
    const check = await checker()
    await withKey(secret, async (secretFile) => {
      let aborted = false
      const request: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error(`timeout cause ${secret}`))
        }, { once: true })
      })
      expect(await check({ secretFile, fetch: request, timeoutMs: 5 })).toEqual({
        ok: false, reason: 'timeout', status: null, modelPresent: null,
      })
      expect(aborted).toBe(true)
    })
  })

  it.each([200, 401])('returns an explicit CLI exit status for HTTP %s with safe diagnostics only', async (status) => {
    await checker()
    await withKey(secret, async (_secretFile, directory) => {
      const preload = join(directory, 'provider-stub.mjs')
      await writeFile(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(status === 200 ? '{"data":[{"id":"deepseek-chat"}]}' : `private response ${secret}`)}, { status: ${String(status)} })\n`)
      const output = await execute(process.execPath, ['--import', pathToFileURL(preload).href, script], {
        env: { ...process.env, DSH_NOVEL_SECRET_DIRECTORY: directory, DSH_NOVEL_PROVIDER_MODEL: 'deepseek-chat' },
      }).then(result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }), (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error) || !('stdout' in error) || !('stderr' in error)) throw error
        return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }
      })
      expect(output.code).toBe(status === 200 ? 0 : 1)
      expect(output.stdout + output.stderr).not.toContain(secret)
      expect(output.stdout + output.stderr).not.toContain('private response')
      expect(JSON.parse(output.stdout || output.stderr)).toEqual({
        ok: status === 200, reason: status === 200 ? 'passed' : 'http-status', status, modelPresent: status === 200 ? true : null,
      })
    })
  })
})
