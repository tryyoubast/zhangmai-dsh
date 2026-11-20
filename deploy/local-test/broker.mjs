/** Inspect and arrange only the isolated acceptance stream, using the worker's existing broker credential. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const [action, workspaceId, generationRunId] = process.argv.slice(2)
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value ?? '')
if (!['pending', 'reserve', 'duplicate', 'spoof'].includes(action)
  || (action !== 'pending' && (!uuid(workspaceId) || !uuid(generationRunId)))) {
  console.error('Staging broker operation requires a supported action and UUID locators')
  process.exit(1)
}

const { Redis } = createRequire(new URL('../../packages/host/novel-host/package.json', import.meta.url))('ioredis')
const host = process.env.DSH_NOVEL_REDIS_HOST ?? 'redis'
if (host !== 'redis') throw new Error('Broker inspection requires the isolated redis service')
const stream = process.env.DSH_NOVEL_REDIS_STREAM ?? 'dsh:novel:generation'
const group = process.env.DSH_NOVEL_REDIS_GROUP ?? 'novel-workers'
const client = new Redis({
  host, port: Number(process.env.DSH_NOVEL_REDIS_PORT ?? 6379),
  password: (await readFile(`${process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets'}/redis-password`, 'utf8')).trim(),
  lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 5_000, connectTimeout: 5_000,
})
client.on('error', () => { /* Operation errors reject below; no client exception is logged with credentials. */ })

async function run() {
  await client.connect()
  if (action === 'pending') {
    const pending = await client.xpending(stream, group)
    const groups = await client.xinfo('GROUPS', stream)
    const details = groups.map(fields => Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) =>
      [fields[index * 2], fields[index * 2 + 1]]))).find(value => value.name === group)
    if (details === undefined || !Number.isSafeInteger(details.lag)) throw new Error('Expected isolated stream group metadata')
    return { pending: Number(pending[0]), lag: details.lag }
  }
  if (action === 'reserve') {
    const messages = await client.xreadgroup('GROUP', group, 'acceptance-stranded', 'COUNT', 1, 'STREAMS', stream, '>')
    const fields = messages?.[0]?.[1]?.[0]?.[1]
    if (JSON.stringify(fields) !== JSON.stringify(['workspaceId', workspaceId, 'generationRunId', generationRunId])) {
      throw new Error('Expected the isolated queued fixture')
    }
    return { reserved: true }
  }
  const fields = ['workspaceId', workspaceId, 'generationRunId', generationRunId]
  if (action === 'spoof') fields.push('userId', 'attacker', 'roles', 'owner', 'agentPrincipalId', 'forged-worker')
  await client.xadd(stream, '*', ...fields)
  return { notified: true }
}

try {
  console.log(JSON.stringify(await run()))
} catch {
  console.error('Staging broker operation failed; credentials are redacted.')
  process.exitCode = 1
} finally {
  client.disconnect()
}
