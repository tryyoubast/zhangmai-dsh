import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Config } from '../../../host/novel-host/src/config.ts'

describe('novel profile bundle', () => {
  it('inserts one standalone host and binds every deployment value through its validated Config', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      dsh: unknown
      dependencies: Record<string, string>
    }
    expect(manifest.dsh).toEqual({ bundle: { patch: './cordis.patch.yml' } })
    const source = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    const patch = load(source, { schema: entryListSchema }) as Array<{ insert: Array<{ id: string; name: string; config: unknown }> }>
    expect(patch).toHaveLength(1)
    expect(patch[0]!.insert).toHaveLength(1)
    expect(patch[0]!.insert[0]).toMatchObject({ id: 'novel-host', name: '@deepseek-ai/dsh-novel-host' })
    const evaluate = (value: unknown): unknown => {
      if (typeof value !== 'object' || value === null) return value
      if ('__jsExpr' in value) {
        return runInNewContext(`(${String(value.__jsExpr)})`, { process: { env: { DSH_NOVEL_MODE: 'api' } } }) as unknown
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item)]))
    }
    const config = Config(evaluate(patch[0]!.insert[0]!.config) as Config)
    expect(config.mode).toBe('api')
    expect(config.redis.stream).toBe('dsh:novel:generation')
    expect(config.redis.commandTimeoutMs).toBeGreaterThan(config.redis.blockMs)
    expect(config.provider.timeoutMs).toBe(120000)
    expect(Object.keys(manifest.dependencies)).toEqual(['@deepseek-ai/dsh-novel-host'])
  })
})
