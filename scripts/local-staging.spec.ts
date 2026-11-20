import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const command = resolve(import.meta.dirname, '../deploy/local-test/manage.mjs')

async function captureCommands<T>(run: (state: string, preload: string, calls: () => Promise<string[][]>) => Promise<T>): Promise<T> {
  const state = await mkdtemp(join(tmpdir(), 'dsh-local-routing-'))
  try {
    const preload = join(state, 'capture-spawn.mjs')
    const capture = join(state, 'calls.jsonl')
    await writeFile(preload, `import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
childProcess.spawn = (_command, args) => {
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n')
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  queueMicrotask(() => {
    if (args[0] === 'info') child.stdout.emit('data', '{"OSType":"linux"}')
    child.emit('exit', 0)
  })
  return child
}
syncBuiltinESMExports()
`)
    return await run(state, pathToFileURL(preload).href, async () => {
      try {
        return (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
        throw error
      }
    })
  } finally {
    await rm(state, { recursive: true, force: true })
  }
}

describe('local staging initialization', () => {
  it('creates independent credentials and a working EdDSA pair without replacing existing secrets', async () => {
    const state = await mkdtemp(join(tmpdir(), 'dsh-local-test-'))
    try {
      await expect(execute(process.execPath, [command, 'init', '--state-dir', state])).resolves.toBeDefined()
      const names = ['postgres-password', 'migrator-password', 'auth-password', 'app-password', 'worker-password', 'service-password', 'refresh-auth-password', 'refresh-migrator-password', 'redis-password']
      const before = await Promise.all(names.map(name => readFile(join(state, 'secrets', name), 'utf8')))
      expect(new Set(before).size).toBe(names.length)
      expect(before.every(secret => secret.trim().length >= 32)).toBe(true)
      const privateKey = createPrivateKey(await readFile(join(state, 'secrets', 'access-private.pem')))
      const publicKey = createPublicKey(await readFile(join(state, 'secrets', 'access-public.pem')))
      const payload = Buffer.from('staging verification')
      expect(verify(null, payload, publicKey, sign(null, payload, privateKey))).toBe(true)
      await writeFile(join(state, 'secrets', 'deepseek-api-key'), 'user-supplied-key')
      await execute(process.execPath, [command, 'init', '--state-dir', state])
      expect(await Promise.all(names.map(name => readFile(join(state, 'secrets', name), 'utf8')))).toEqual(before)
      expect(await readFile(join(state, 'secrets', 'deepseek-api-key'), 'utf8')).toBe('user-supplied-key')
      for (const profile of ['novel-api', 'novel-worker']) {
        const manifest: unknown = JSON.parse(await readFile(join(state, 'home', 'profiles', profile, 'package.json'), 'utf8'))
        expect(manifest).toMatchObject({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-novel-app'], patchReload: 'startup' } } })
      }
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  it('refuses a data reset without the explicit project confirmation', async () => {
    const error: unknown = await execute(process.execPath, [command, 'reset']).catch((failure: unknown) => failure)
    if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') {
      throw new Error('reset must fail before Docker is contacted')
    }
    expect(error).toHaveProperty('code', 1)
    expect(error.stderr).toContain('--confirm=dsh-local-test')
  })

  it('provides a package command for the isolated provider credential preflight', async () => {
    const manifest: unknown = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'))
    expect(manifest).toMatchObject({ scripts: { 'staging:check:provider': 'node deploy/local-test/manage.mjs check:provider' } })
  })

  it('routes the provider preflight without building or starting application services and prints key metadata only', async () => {
    await captureCommands(async (state, preload, calls) => {
      await mkdir(join(state, 'secrets'))
      const secretFile = join(state, 'secrets', 'deepseek-api-key')
      await writeFile(secretFile, 'never-print-this-provider-key')
      const output = await execute(process.execPath, ['--import', preload, command, 'check:provider', '--state-dir', state])
      const invocations = await calls()
      expect(invocations).toHaveLength(3)
      expect(invocations[0]).toEqual(['info', '--format', '{{json .}}'])
      expect(invocations[1]).toEqual(['compose', 'version'])
      expect(invocations[2]?.slice(-4)).toEqual(['run', '--rm', '--no-deps', 'provider-check'])
      expect(JSON.parse(output.stdout)).toEqual({
        keyPath: await realpath(secretFile), modifiedAt: (await stat(secretFile)).mtime.toISOString(),
      })
      expect(output.stdout + output.stderr).not.toContain('never-print-this-provider-key')
    })
  })

  it('forwards --resume only to real acceptance while preserving its state directory', async () => {
    await captureCommands(async (state, preload, calls) => {
      await execute(process.execPath, ['--import', preload, command, 'test:real', '--resume', '--state-dir', state])
      const invocations = await calls()
      expect(invocations.at(-1)).toEqual([
        '--import', 'tsx/esm', resolve(import.meta.dirname, '../deploy/local-test/acceptance.ts'), '--state-dir', state, '--real', '--resume',
      ])
    })
  })

  it.each(['up', 'restart', 'down', 'reset'])('refuses %s while acceptance owns the shared worker', async (operation) => {
    await captureCommands(async (state, preload, calls) => {
      await mkdir(join(state, 'evidence'))
      const path = join(state, 'evidence/real-provider-budget.lock'), lock = 'unknown-owner'
      await writeFile(path, lock)
      const confirmation = operation === 'reset' ? ['--confirm=dsh-local-test'] : []
      await expect(execute(process.execPath, ['--import', preload, command, operation, ...confirmation, '--state-dir', state]))
        .rejects.toHaveProperty('code', 1)
      expect(await calls()).toEqual([['info', '--format', '{{json .}}'], ['compose', 'version']])
      expect(await readFile(path, 'utf8')).toBe(lock)
    })
  })

  it.each(['init', 'up', 'test', 'postgres', 'restart', 'down', 'reset', 'check:provider'])('rejects --resume for %s before invoking Docker', async (operation) => {
    await captureCommands(async (state, preload, calls) => {
      const result: unknown = await execute(process.execPath, ['--import', preload, command, operation, '--resume', '--state-dir', state])
        .catch((error: unknown) => error)
      expect(result).toHaveProperty('code', 1)
      expect(result).toHaveProperty('stderr', '--resume is only supported for test:real\n')
      expect(await calls()).toEqual([])
    })
  })

  it.each([['test', '--supplement'], ['test:real', '--supplemnt'], ['test:real', '--supplement', '--supplement']])(
    'rejects invalid supplemental arguments before invoking Docker: %j', async (...arguments_) => {
      await captureCommands(async (state, preload, calls) => {
        await expect(execute(process.execPath, ['--import', preload, command, ...arguments_, '--state-dir', state]))
          .rejects.toHaveProperty('code', 1)
        expect(await calls()).toEqual([])
      })
    },
  )

  it('forwards the supplemental resume flags to the acceptance runner', async () => {
    await captureCommands(async (state, preload, calls) => {
      await execute(process.execPath, ['--import', preload, command, 'test:real', '--supplement', '--resume', '--state-dir', state])
      expect((await calls()).at(-1)).toEqual(['--import', 'tsx/esm', resolve(import.meta.dirname, '../deploy/local-test/acceptance.ts'),
        '--state-dir', resolve(state), '--real', '--supplement', '--resume'])
    })
  })
})
