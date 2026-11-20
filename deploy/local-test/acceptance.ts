/** Exercise the deployed profiles through HTTPS; database inspection only supplements HTTP assertions. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import { StagingHttpClient } from './http-client.ts'
import { interruptWorkerAfter, restoreFixedModelWorker, stagingProviderEnvironment } from './acceptance-worker.ts'
import { RealBudgetError, withAcceptanceLock, withRealBudget, type RealBudgetLease } from './real-budget.ts'
import { executeRemainingRealFlow, REAL_CONTINUATION_INSTRUCTION, ResumeFlowError, type ResumeSnapshot } from './real-resume.ts'
import { executeRealSupplement, SupplementFlowError } from './real-supplement.ts'
import { readSupplementLogin, saveSupplementLogin } from './supplement-login.ts'

const execute = promisify(execFile)
const directory = import.meta.dirname
const arguments_ = process.argv.slice(2)
const real = arguments_.includes('--real')
const resume = arguments_.includes('--resume')
const supplement = arguments_.includes('--supplement')
const stateIndex = arguments_.indexOf('--state-dir')
const state = resolve(stateIndex === -1 ? process.env.DSH_LOCAL_STATE ?? join(directory, '.local') : arguments_[stateIndex + 1] ?? '')
const origin = 'https://localhost:8443'
const root = resolve(directory, '../..')
const docker = process.platform === 'win32' && existsSync('C:/Program Files/Docker/Docker/resources/bin/docker.exe')
  ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker'
const evidence: Array<{ scenario: string; status: 'passed' | 'failed' }> = []
const supplementalState = 'E:/Codex/staging-acceptance/local-state'
const historicalBudgetHash = '80ef714534c47620049485e60d892ec472c730e5a8ffdfb3d7b40641f666f8b1'
const supplementalModel = 'deepseek-flash'

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected JSON object')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  assert(typeof value === 'string' && value !== '', 'Expected nonempty string')
  return value
}

async function compose(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execute(docker, ['compose', '--project-name', 'dsh-local-test', '--env-file', join(directory, 'images.lock.env'), '--file', join(directory, 'compose.yml'), ...args], {
    cwd: root, env: { ...stagingProviderEnvironment(process.env, environment), DSH_LOCAL_STATE: state }, maxBuffer: 4_194_304, windowsHide: true,
  })
  return result.stdout
}

async function scenario<T>(name: string, callback: () => Promise<T>): Promise<T> {
  try {
    const result = await callback()
    evidence.push({ scenario: name, status: 'passed' })
    console.log(`PASS ${name}`)
    return result
  } catch {
    evidence.push({ scenario: name, status: 'failed' })
    // Provider responses, mail, request bodies, and child errors can contain credentials.
    throw new Error(`Acceptance failed: ${name}`)
  }
}

async function api(client: StagingHttpClient, path: string, status: number, body?: unknown, headers?: Record<string, string>) {
  const response = await client.request(path, { method: body === undefined ? 'GET' : 'POST', body, ...(headers === undefined ? {} : { headers }) })
  if (response.status !== status) console.error(`HTTP status mismatch: ${path.split('?')[0]} expected ${String(status)}, received ${String(response.status)}`)
  assert.equal(response.status, status, 'Unexpected HTTP status')
  return response.body === null ? {} : record(response.body)
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await read()
    if (value !== undefined) return value
    await pause(100)
  } while (Date.now() < deadline)
  throw new Error('Acceptance condition timed out')
}

async function mailToken(email: string, template: string): Promise<string> {
  return until(async () => {
    const response = await fetch('http://127.0.0.1:8025/api/v1/messages', { signal: AbortSignal.timeout(5_000) })
    assert(response.ok)
    const messages = record(await response.json()).messages
    assert(Array.isArray(messages))
    for (const value of messages as unknown[]) {
      const message = record(value)
      if (!Array.isArray(message.To) || !message.To.some((to: unknown) => record(to).Address === email)) continue
      const detail = await fetch(`http://127.0.0.1:8025/api/v1/message/${encodeURIComponent(text(message.ID))}`, { signal: AbortSignal.timeout(5_000) })
      assert(detail.ok)
      const body = record(await detail.json())
      const content = typeof body.Text === 'string' ? body.Text : ''
      if (!content.includes(template)) continue
      const token = /^Token: (\S+)$/mu.exec(content)?.[1]
      if (token !== undefined) return token
    }
    return undefined
  })
}

async function account(ca: string) {
  const client = new StagingHttpClient(origin, ca)
  const email = `staging-${randomUUID()}@test.invalid`
  const password = `A!9${randomBytes(24).toString('hex')}`
  await api(client, '/api/auth/register', 202, { email, password })
  await api(client, '/api/auth/login', 401, { email, password })
  const token = await mailToken(email, 'email-verification')
  await api(client, '/api/auth/verify-email', 204, { token })
  await api(client, '/api/auth/verify-email', 400, { token })
  const second = new StagingHttpClient(origin, ca)
  await Promise.all([client, second].map(browser => api(browser, '/api/auth/login', 200, { email, password })))
  const [identity, other] = await Promise.all([api(client, '/api/auth/me', 200), api(second, '/api/auth/me', 200)])
  assert.equal(identity.workspaceId, other.workspaceId)
  const cookies = await client.jar.getCookies(origin)
  const cookie = cookies.find(value => value.key === '__Host-dsh_session')
  assert(cookie?.secure && cookie.httpOnly && cookie.hostOnly && cookie.path === '/' && cookie.sameSite === 'lax')
  return { client, email, password, workspaceId: text(identity.workspaceId), userId: text(identity.userId), sessionId: text(identity.sessionId) }
}

async function completed(client: StagingHttpClient, novelId: string, runId: string, expected = 'completed') {
  return until(async () => {
    const run = await api(client, `/api/novels/${novelId}/generation-runs/${runId}`, 200)
    if (run.status === 'queued' || run.status === 'running') return undefined
    assert.equal(run.status, expected)
    assert(Array.isArray(run.proposals))
    return { ...run, proposals: (run.proposals as unknown[]).map(record) }
  }, real ? 120_000 : 30_000)
}

type StagingOwner = Pick<Awaited<ReturnType<typeof account>>, 'client' | 'workspaceId'>

async function generate(owner: StagingOwner, novelId: string, instruction: string, limit = 0, key: string = randomUUID()) {
  const body = { workspaceId: owner.workspaceId, instruction, idempotencyKey: key, limit }
  const response = await api(owner.client, `/api/novels/${novelId}/generate`, 202, body)
  return { runId: text(response.runId), body }
}

async function inspect(args: string[]) {
  return record(JSON.parse(await compose(['run', '--rm', '--no-deps', 'inspection', ...args])) as unknown)
}

async function broker(args: string[]) {
  return record(JSON.parse(await compose(['exec', '-T', 'api', 'node', 'deploy/local-test/broker.mjs', ...args])) as unknown)
}

async function drained() {
  await until(async () => {
    const pending = await broker(['pending'])
    return pending.pending === 0 && pending.lag === 0 ? true : undefined
  })
}

async function restart() {
  await compose(['restart', 'api', 'worker'])
  const ca = await readFile(join(state, 'local-ca.crt'), 'utf8')
  const client = new StagingHttpClient(origin, ca)
  await until(async () => {
    try { return (await client.request('/health/ready')).status === 200 ? true : undefined } catch { return undefined }
  })
}

async function contextPreflight(workspaceId: string, novelId: string, seedRunId: string, instruction: string, limit: number): Promise<ResumeSnapshot['context']> {
  const value = record(JSON.parse(await compose(['exec', '-T', 'worker', 'node', 'deploy/local-test/context-preflight.mjs',
    workspaceId, novelId, seedRunId, instruction, String(limit)])) as unknown)
  assert(Array.isArray(value.context))
  const items: unknown[] = value.context
  return items.map(value => {
    const item = record(value)
    assert(typeof item.rank === 'number' && Number.isInteger(item.rank))
    return { sourceType: text(item.sourceType), sourceId: text(item.sourceId), rank: item.rank, excerptHash: text(item.excerptHash) }
  })
}

async function mockFlow(ca: string) {
  const { human, other } = await scenario('registration, one-use mail verification, concurrent first login, secure cookies', async () => {
    const human = await account(ca)
    const other = await account(ca)
    const stored = await inspect(['workspace', human.userId])
    assert.equal(stored.memberships, 1)
    assert.equal(stored.ownedWorkspaces, 1)
    return { human, other }
  })
  const novelId = text((await api(human.client, `/api/workspaces/${human.workspaceId}/novels`, 200, { title: 'Local acceptance' })).id)
  await scenario('origin, workspace and source-session isolation', async () => {
    const denied = await human.client.request('/api/auth/login', { method: 'POST', body: {}, headers: { origin: 'https://attacker.invalid' } })
    assert.equal(denied.status, 403)
    await api(human.client, `/api/novels/${novelId}/generate`, 400, { workspaceId: human.workspaceId, instruction: 'fixture:all', idempotencyKey: randomUUID(), sourceSessionId: other.sessionId })
    await api(other.client, `/api/workspaces/${human.workspaceId}/novels`, 403, { title: 'Denied' }, { 'x-dsh-user-id': human.userId, 'x-dsh-roles': 'owner' })
    await api(other.client, `/api/novels/${novelId}/generation-runs/${randomUUID()}`, 404)
  })
  await scenario('archived workspace blocks authoring but its owner can sign in and restore it', async () => {
    const path = `/api/workspaces/${other.workspaceId}`
    await api(other.client, path, 200, { action: 'archive' })
    await api(other.client, `${path}/novels`, 401, { title: 'Denied while archived' })
    await api(human.client, path, 401, { action: 'restore' })
    await api(other.client, '/api/auth/logout', 204, {})
    await api(other.client, '/api/auth/login', 200, { email: other.email, password: other.password })
    await api(other.client, path, 401, { action: 'restore' }, { 'x-dsh-workspace-id': human.workspaceId })
    assert.equal((await api(other.client, path, 200, { action: 'restore' })).status, 'active')
    assert.equal((await api(other.client, '/api/auth/me', 200)).workspaceId, other.workspaceId)
  })
  let firstRun = ''
  let firstProposals: Record<string, unknown>[] = []
  await scenario('queued generation persists all fourteen draft types and preserves idempotency', async () => {
    const queued = await generate(human, novelId, 'fixture:all')
    firstRun = queued.runId
    const run = await completed(human.client, novelId, firstRun)
    firstProposals = run.proposals
    assert.equal(new Set(firstProposals.map(proposal => proposal.targetType)).size, 14)
    assert(firstProposals.every(proposal => proposal.status === 'draft'))
    const again = await api(human.client, `/api/novels/${novelId}/generate`, 202, queued.body)
    assert.equal(again.runId, firstRun)
    const stored = await inspect(['run', human.workspaceId, novelId, firstRun])
    assert.equal(stored.draftTargets, 14)
    assert.equal(stored.proposals, 14)
    assert.equal(stored.providerCalls, 1)
    await api(other.client, `/api/novels/${novelId}/generation-runs/${firstRun}`, 404)
    await api(human.client, `/api/novels/${novelId}/generate`, 409, { ...queued.body, instruction: 'Changed instruction' })
  })
  await scenario('worker cannot approve, publish or roll back persisted drafts', async () => {
    const proposal = firstProposals.find(value => value.targetType === 'characters')
    assert(proposal)
    const output = await compose(['exec', '-T', 'worker', 'node', 'deploy/local-test/worker-denials.mjs',
      human.workspaceId, firstRun, text(proposal.id), text(proposal.targetId)])
    assert.deepEqual(record(JSON.parse(output) as unknown), { review: true, publish: true, rollback: true })
    assert((await completed(human.client, novelId, firstRun)).proposals.every(value => value.status === 'draft'))
  })
  await scenario('stranded queued notifications recover once after worker restart', async () => {
    await drained()
    await compose(['stop', 'worker'])
    let queued: Awaited<ReturnType<typeof generate>>
    try {
      queued = await generate(human, novelId, 'fixture:continuation')
      assert.equal((await api(human.client, `/api/novels/${novelId}/generation-runs/${queued.runId}`, 200)).status, 'queued')
      assert.equal((await broker(['reserve', human.workspaceId, queued.runId])).reserved, true)
    } finally {
      await compose(['up', '--detach', '--no-deps', 'worker'])
    }
    await completed(human.client, novelId, queued.runId)
    await drained()
    assert.equal((await inspect(['run', human.workspaceId, novelId, queued.runId])).providerCalls, 1)
  })
  await scenario('interrupted running work fails without a second provider call', async () => {
    await drained()
    const queued = await interruptWorkerAfter(compose, async () => {
      const queued = await generate(human, novelId, 'fixture:hold')
      await until(async () => {
        const run = await api(human.client, `/api/novels/${novelId}/generation-runs/${queued.runId}`, 200)
        const stored = await inspect(['run', human.workspaceId, novelId, queued.runId])
        return run.status === 'running' && stored.providerCalls === 1 ? true : undefined
      })
      return queued
    })
    await completed(human.client, novelId, queued.runId, 'failed')
    await broker(['duplicate', human.workspaceId, queued.runId])
    await broker(['spoof', human.workspaceId, queued.runId])
    await broker(['duplicate', other.workspaceId, queued.runId])
    await drained()
    const stored = await inspect(['run', human.workspaceId, novelId, queued.runId])
    assert.equal(stored.providerCalls, 1)
    assert.equal(stored.proposals, 0)
  })
  await scenario('failed broker notification returns 503 and the same key restores delivery', async () => {
    await drained()
    const body = { workspaceId: human.workspaceId, instruction: 'fixture:continuation', idempotencyKey: randomUUID(), limit: 0 }
    await compose(['stop', 'redis'])
    try {
      await api(human.client, `/api/novels/${novelId}/generate`, 503, body)
    } finally {
      await compose(['up', '--detach', '--wait', 'redis'])
    }
    await until(async () => {
      const response = await human.client.request('/health/ready')
      return response.status === 200 ? true : undefined
    })
    const queued = await api(human.client, `/api/novels/${novelId}/generate`, 202, body)
    const runId = text(queued.runId)
    await completed(human.client, novelId, runId)
    assert.equal((await api(human.client, `/api/novels/${novelId}/generate`, 202, body)).runId, runId)
    await drained()
    assert.equal((await inspect(['run', human.workspaceId, novelId, runId])).providerCalls, 1)
  })
  await scenario('invalid model output, SQL, publication commands and partial materialization', async () => {
    for (const fixture of ['invalid', 'sql', 'published', 'partial']) {
      const queued = await generate(human, novelId, `fixture:${fixture}`)
      const run = await completed(human.client, novelId, queued.runId, 'failed')
      assert.equal(run.proposals.length, fixture === 'partial' ? 1 : 0)
    }
  })
  await scenario('human review and publication; other workspaces and workers cannot publish', async () => {
    for (const proposal of firstProposals) {
      const id = text(proposal.id)
      const foreign = await other.client.request(`/api/proposals/${id}/review`, { method: 'POST', body: { decision: 'approved' } })
      assert(foreign.status >= 400 && foreign.status < 500)
      await api(human.client, `/api/proposals/${id}/review`, 200, { decision: 'approved' })
      await api(human.client, `/api/proposals/${id}/publish`, 200, {})
    }
    assert.equal((await inspect(['run', human.workspaceId, novelId, firstRun])).publishedTargets, 14)
  })
  await scenario('character and location update, version conflict and rollback', async () => {
    for (const targetType of ['characters', 'locations']) {
      const proposal = firstProposals.find(value => value.targetType === targetType)
      assert(proposal)
      const targetId = text(proposal.targetId)
      const before = await inspect(['target', human.workspaceId, novelId, targetType, targetId])
      const update = { targetType, targetId, operation: 'update', baseVersionNo: before.versionNo, name: 'Updated fixture', summary: 'Updated summary', attributes: {} }
      const queued = await generate(human, novelId, `fixture:proposal ${JSON.stringify(update)}`)
      const updated = await completed(human.client, novelId, queued.runId)
      const updateId = text(updated.proposals[0]?.id)
      const competing = await generate(human, novelId, `fixture:proposal ${JSON.stringify(update)}`)
      const competingRun = await completed(human.client, novelId, competing.runId)
      const competingId = text(competingRun.proposals[0]?.id)
      await api(human.client, `/api/proposals/${updateId}/review`, 200, { decision: 'approved' })
      await api(human.client, `/api/proposals/${competingId}/review`, 200, { decision: 'approved' })
      await api(human.client, `/api/proposals/${updateId}/publish`, 200, {})
      await api(human.client, `/api/proposals/${competingId}/publish`, 409, {})
      assert.equal((await inspect(['target', human.workspaceId, novelId, targetType, targetId])).name, 'Updated fixture')
      const conflict = await generate(human, novelId, `fixture:proposal ${JSON.stringify(update)}`)
      const stale = await completed(human.client, novelId, conflict.runId)
      const staleId = text(stale.proposals[0]?.id)
      await api(human.client, `/api/proposals/${staleId}/review`, 200, { decision: 'approved' })
      await api(human.client, `/api/proposals/${staleId}/publish`, 409, {})
      await api(human.client, `/api/proposals/${updateId}/rollback`, 200, { targetType, targetId, versionNo: before.versionNo })
      assert.equal((await inspect(['target', human.workspaceId, novelId, targetType, targetId])).name, before.name)
      await api(human.client, `/api/proposals/${competingId}/publish`, 409, {})
    }
  })
  await scenario('restart preserves accounts, drafts, versions and selected context', async () => {
    await restart()
    assert.equal((await api(human.client, '/api/auth/me', 200)).workspaceId, human.workspaceId)
    assert.equal((await completed(human.client, novelId, firstRun)).proposals.length, 14)
    const continuation = await generate(human, novelId, 'Moon Harbor', 8)
    await completed(human.client, novelId, continuation.runId)
    const context = await api(human.client, `/api/novels/${novelId}/context/${continuation.runId}`, 200)
    assert(Array.isArray(context.context) && context.context.length > 0)
  })
  await scenario('full continuation instruction retrieves prepared history and survives a second restart', async () => {
    // Independent fixtures keep chapter 2 free for any later, separately authorized real campaign.
    const owner = await account(ca)
    const novelId = text((await api(owner.client, `/api/workspaces/${owner.workspaceId}/novels`, 200, { title: 'Keyless full-instruction continuation' })).id)
    const seed = await generate(owner, novelId, 'fixture:all')
    const prepared = await completed(owner.client, novelId, seed.runId)
    const targetIds = new Set(prepared.proposals.map(proposal => text(proposal.targetId)))
    const before = await inspect(['run', owner.workspaceId, novelId, seed.runId])
    await drained()
    await restart()
    assert.equal((await api(owner.client, '/api/auth/me', 200)).workspaceId, owner.workspaceId)
    assert.deepEqual(await inspect(['run', owner.workspaceId, novelId, seed.runId]), before)
    const preflight = await contextPreflight(owner.workspaceId, novelId, seed.runId, REAL_CONTINUATION_INSTRUCTION, 8)
    assert(preflight.length > 0 && preflight.every(item => targetIds.has(item.sourceId)))
    const generated = await generate(owner, novelId, REAL_CONTINUATION_INSTRUCTION, 8)
    const run = await completed(owner.client, novelId, generated.runId)
    assert.equal(run.proposals.length, 3)
    assert.deepEqual(new Set(run.proposals.map(proposal => proposal.targetType)), new Set(['characters', 'locations', 'chapters']))
    assert(run.proposals.every(proposal => proposal.status === 'draft' && typeof proposal.targetId === 'string'))
    const stored = await inspect(['run', owner.workspaceId, novelId, generated.runId])
    assert.equal(stored.draftTargets, 3)
    assert.equal(stored.providerCalls, 1)
    assert.deepEqual(stored.chapterNumbers, [2])
    const selected = await api(owner.client, `/api/novels/${novelId}/context/${generated.runId}`, 200)
    assert(Array.isArray(selected.context) && selected.context.length > 0)
    for (const item of selected.context as unknown[]) assert(targetIds.has(text(record(item).sourceId)))
    await drained()
    await restart()
    assert.deepEqual(await completed(owner.client, novelId, generated.runId), run)
    assert.deepEqual(await api(owner.client, `/api/novels/${novelId}/context/${generated.runId}`, 200), selected)
    assert.deepEqual(await inspect(['run', owner.workspaceId, novelId, generated.runId]), stored)
  })
  await scenario('official JWT refresh, replay 401, logout and password reset revoke sessions', async () => {
    const credentials = { email: human.email, password: human.password, clientType: 'official-client' }
    const login = await api(human.client, '/api/auth/login', 200, credentials)
    const token = text(login.refreshToken)
    const rotated = await api(human.client, '/api/auth/refresh', 200, { refreshToken: token })
    await api(human.client, '/api/auth/refresh', 401, { refreshToken: token })
    await api(human.client, '/api/auth/refresh', 401, { refreshToken: text(rotated.refreshToken) })
    await api(human.client, '/api/auth/logout', 204, {}, { authorization: `Bearer ${text(rotated.accessToken)}` })
    await api(human.client, '/api/auth/forgot-password', 202, { email: human.email })
    const resetToken = await mailToken(human.email, 'password-reset')
    const password = `A!9${randomBytes(24).toString('hex')}`
    await api(human.client, '/api/auth/reset-password', 204, { token: resetToken, password })
    await api(human.client, '/api/auth/login', 401, credentials)
    await api(human.client, '/api/auth/me', 401)
    await api(human.client, '/api/auth/login', 200, { email: human.email, password })
    assert.equal((await api(human.client, '/api/auth/me', 200)).workspaceId, human.workspaceId)
    await api(human.client, '/api/auth/logout', 204, {})
    await api(human.client, '/api/auth/me', 401)
  })
  await scenario('Redis login rate limiting', async () => {
    const email = `limited-${randomUUID()}@test.invalid`
    for (let index = 0; index < 10; index++) await api(human.client, '/api/auth/login', 401, { email, password: 'Wrong-password-123!' })
    await api(human.client, '/api/auth/login', 429, { email, password: 'Wrong-password-123!' })
  })
  await scenario('original PostgreSQL P0 concurrency regression', async () => { await compose(['run', '--rm', 'regression']) })
  await scenario('restricted worker identity, queue claims and workspace PostgreSQL regressions', async () => {
    await compose(['run', '--rm', 'staging-regression'])
  })
  await scenario('forward publication upgrade preserves legacy rows and rejects provenance collisions', async () => {
    await compose(['run', '--rm', 'upgrade-regression'])
  })
  await scenario('interrupted bootstrap and runtime grant recovery', async () => {
    await execute(process.execPath, [join(directory, 'bootstrap-recovery.mjs')], {
      cwd: root, env: { ...process.env, DSH_LOCAL_STATE: state }, windowsHide: true,
    })
  })
}

async function containerInfo(service: 'api' | 'worker', template: string) {
  const id = (await compose(['ps', '--quiet', service])).trim()
  assert(id !== '')
  const result = await execute(docker, ['inspect', '--format', template, id], { cwd: root, windowsHide: true })
  return result.stdout.trim()
}

async function imageEvidence() {
  return { api: await containerInfo('api', '{{.Image}}'), worker: await containerInfo('worker', '{{.Image}}') }
}

async function verifyRealPrerequisites(ca: string, requireCurrentImages = false) {
  const mock = record(JSON.parse(await readFile(join(state, 'evidence/mock-acceptance.json'), 'utf8')) as unknown)
  assert.equal(mock.mode, 'mock')
  assert(Array.isArray(mock.scenarios) && mock.scenarios.length >= (requireCurrentImages ? 18 : 17))
  const scenarios: unknown[] = mock.scenarios
  assert(scenarios.every(value => record(value).status === 'passed'))
  assert.equal(new Set(scenarios.map(value => text(record(value).scenario))).size, scenarios.length)
  const images = requireCurrentImages ? await imageEvidence() : undefined
  if (images !== undefined) assert.deepEqual(mock.images, images)
  await api(new StagingHttpClient(origin, ca), '/health/ready', 200)
  const keyPath = await realpath(join(state, 'secrets/deepseek-api-key'))
  console.log(JSON.stringify({ keyPath, modifiedAt: (await stat(keyPath)).mtime.toISOString() }))
  try {
    const result = record(JSON.parse(await compose(['run', '--rm', '--no-deps', 'provider-check'])) as unknown)
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(result.modelPresent, true)
    console.log(JSON.stringify({ providerPreflight: 'passed', status: 200, modelPresent: true }))
  } catch {
    throw new Error('Real acceptance provider preflight failed; run staging:check:provider for its safe status')
  }
  return images
}

async function restoreAndVerifyFixedWorker() {
  await restoreFixedModelWorker(compose)
  const status = await containerInfo('worker', '{{.State.Running}}|{{range .Config.Env}}{{if eq . "DSH_NOVEL_PROVIDER_URL=http://model:8081/v1"}}fixed{{end}}{{end}}')
  assert.equal(status, 'true|fixed', 'Fixed-model worker restoration failed')
}

async function realFlow(ca: string, lease: RealBudgetLease) {
  const owner = await account(ca)
  const novelId = text((await api(owner.client, `/api/workspaces/${owner.workspaceId}/novels`, 200, { title: 'Bounded real provider acceptance' })).id)
    await compose(['up', '--detach', '--no-deps', '--force-recreate', 'worker'], { DSH_NOVEL_PROVIDER_URL: 'https://api.deepseek.com/v1' })
    for (const index of [1, 2]) {
      await scenario(`real provider generation ${String(index)}`, async () => {
        await lease.reserve()
        const instruction = index === 1
          ? 'Return JSON records for one character named Lin (name, summary), one location named Moon Harbor (name, summary), and a chapter (chapterNo:1,title:Moon Harbor,summary). Keep prose under 120 words. Use targetType characters, locations, chapters. Drafts only.'
          : 'Moon Harbor'
        const queued = await generate(owner, novelId, instruction, index === 1 ? 0 : 8)
        const run = await completed(owner.client, novelId, queued.runId)
        assert(run.proposals.length > 0)
        if (index === 1) {
          const types = new Set(run.proposals.map(proposal => proposal.targetType))
          assert(types.has('characters') && types.has('locations') && types.has('chapters'))
          await restart()
        } else {
          const context = await api(owner.client, `/api/novels/${novelId}/context/${queued.runId}`, 200)
          assert(Array.isArray(context.context) && context.context.length > 0)
        }
      })
    }
}

async function readSnapshot(owner: StagingOwner, novelId: string, runId: string, chapter?: 1 | 2): Promise<ResumeSnapshot> {
  const identity = await api(owner.client, '/api/auth/me', 200)
  const run = await completed(owner.client, novelId, runId)
  const selected = await api(owner.client, `/api/novels/${novelId}/context/${runId}`, 200)
  assert(Array.isArray(selected.context))
  const items: unknown[] = selected.context
  const stored = await inspect(['run', owner.workspaceId, novelId, runId])
  assert(typeof stored.savedResults === 'number' && typeof stored.draftTargets === 'number')
  assert(Array.isArray(stored.targets) && Array.isArray(stored.chapterNumbers))
  const targets: unknown[] = stored.targets, chapterNumbers: unknown[] = stored.chapterNumbers
  assert(chapterNumbers.every(value => typeof value === 'number'))
  for (const proposal of run.proposals) {
    assert(targets.some(value => {
      const target = record(value)
      return target.id === proposal.targetId && target.targetType === proposal.targetType && target.status === 'draft'
    }), 'Each proposal must reference its own persisted draft target')
  }
  if (chapter !== undefined) {
    assert.equal(stored.providerCalls, 0, 'A real task cannot have been processed by the fixed model')
    const expected = chapter === 1 ? { characters: 'Lin', locations: 'Moon Harbor' }
      : { characters: 'Lantern Courier', locations: 'Lantern Pier' }
    for (const [type, name] of Object.entries(expected)) {
      const proposal = run.proposals.find(value => value.targetType === type)
      assert(proposal !== undefined)
      const target = await inspect(['target', owner.workspaceId, novelId, type, text(proposal.targetId)])
      assert.equal(target.name, name)
    }
  }
  return {
    workspaceId: text(identity.workspaceId), status: text(record(run).status), savedResults: stored.savedResults, draftTargets: stored.draftTargets,
    chapterNumbers: chapterNumbers.map(value => { assert(typeof value === 'number'); return value }),
    proposals: run.proposals.map(value => ({ id: text(value.id), targetType: text(value.targetType), targetId: text(value.targetId), status: text(value.status) })),
    context: items.map(value => {
      const item = record(value)
      assert(typeof item.rank === 'number')
      return { sourceType: text(item.sourceType), sourceId: text(item.sourceId), rank: item.rank, excerptHash: text(item.excerptHash) }
    }),
  }
}

async function resumedRealFlow(ca: string) {
  let owner: Awaited<ReturnType<typeof account>> | undefined, novelId = '', seedRunId = '', realRunId = ''
  function snapshot(runId: string) {
    assert(owner !== undefined)
    return readSnapshot(owner, novelId, runId)
  }
  try { return await executeRemainingRealFlow(state, {
    preflight: () => scenario('HTTPS, complete mock evidence and real provider preflight', async () => { await verifyRealPrerequisites(ca) }),
    prepareFixed: () => scenario('independent fixed-model fixture contains fourteen draft types', async () => {
      await restoreAndVerifyFixedWorker()
      owner = await account(ca)
      novelId = text((await api(owner.client, `/api/workspaces/${owner.workspaceId}/novels`, 200, { title: 'Remaining real-provider continuation' })).id)
      seedRunId = (await generate(owner, novelId, 'fixture:all')).runId
      await completed(owner.client, novelId, seedRunId)
      return { workspaceId: owner.workspaceId, novelId, seedRunId }
    }),
    seedSnapshot: () => snapshot(seedRunId), drain: () => drained(), restart: () => restart(),
    contextPreflight: (instruction, limit) => scenario('worker context preflight uses the complete continuation instruction', async () => {
      assert(owner !== undefined)
      return contextPreflight(owner.workspaceId, novelId, seedRunId, instruction, limit)
    }),
    selectReal: async () => { await compose(['up', '--detach', '--no-deps', '--force-recreate', 'worker'], { DSH_NOVEL_PROVIDER_URL: 'https://api.deepseek.com/v1' }) },
    submit: (instruction, limit) => scenario('single real task submission reaches completed state', async () => {
      assert(owner !== undefined)
      realRunId = (await generate(owner, novelId, instruction, limit)).runId
      await completed(owner.client, novelId, realRunId)
      return realRunId
    }),
    generatedSnapshot: () => snapshot(realRunId),
    restore: () => scenario('fixed-model worker restored and configuration verified', restoreAndVerifyFixedWorker),
  }) } catch (error) {
    if (error instanceof ResumeFlowError) throw new ResumeFlowError(error.stage, {
      ...error.locators, ...(owner === undefined ? {} : { workspaceId: owner.workspaceId }),
      ...(novelId === '' ? {} : { novelId }), ...(seedRunId === '' ? {} : { seedRunId }), ...(realRunId === '' ? {} : { runId: realRunId }),
    })
    throw error
  }
}

async function supplementalRealFlow(ca: string, recordImages: (images: Awaited<ReturnType<typeof imageEvidence>>) => void) {
  let owner: (StagingOwner & { novelId: string }) | undefined
  return executeRealSupplement(state, resume, historicalBudgetHash, supplementalModel, {
    preflight: () => scenario('current mock evidence, HTTPS and real provider preflight', async () => {
      const images = await verifyRealPrerequisites(ca, true)
      assert(images !== undefined)
      recordImages(images)
    }),
    prepare: () => scenario('isolated supplemental test owner and novel', async () => {
      const accountOwner = await account(ca)
      const { client, workspaceId, userId } = accountOwner
      const novelId = text((await api(client, `/api/workspaces/${workspaceId}/novels`, 200, { title: 'Real Moon Harbor acceptance' })).id)
      await saveSupplementLogin(state, userId, accountOwner)
      owner = { client, workspaceId, novelId }
      return { userId, workspaceId, novelId }
    }),
    attach: async fixture => {
      const client = new StagingHttpClient(origin, ca)
      await api(client, '/api/auth/login', 200, await readSupplementLogin(state, fixture.userId))
      const identity = await api(client, '/api/auth/me', 200)
      assert.equal(identity.userId, fixture.userId)
      assert.equal(identity.workspaceId, fixture.workspaceId)
      owner = { client, workspaceId: fixture.workspaceId, novelId: fixture.novelId }
    },
    drain: drained,
    restart,
    contextPreflight: (seedRunId, instruction, limit) => scenario('worker retrieves only the seed novel before paid continuation', async () => {
      assert(owner !== undefined)
      return contextPreflight(owner.workspaceId, owner.novelId, seedRunId, instruction, limit)
    }),
    selectReal: async () => {
      await compose(['up', '--detach', '--no-deps', '--force-recreate', 'worker'], { DSH_NOVEL_PROVIDER_URL: 'https://api.deepseek.com/v1' })
      const status = await containerInfo('worker', '{{.State.Running}}|{{range .Config.Env}}{{if eq . "DSH_NOVEL_PROVIDER_URL=https://api.deepseek.com/v1"}}real{{end}}{{if eq . "DSH_NOVEL_PROVIDER_MODEL=deepseek-flash"}}model{{end}}{{end}}')
      assert(status === 'true|realmodel' || status === 'true|modelreal')
    },
    submit: async (instruction, limit, key) => {
      assert(owner !== undefined)
      return (await generate(owner, owner.novelId, instruction, limit, key)).runId
    },
    snapshot: async (runId, chapter) => {
      assert(owner !== undefined)
      return readSnapshot(owner, owner.novelId, runId, chapter)
    },
    restore: restoreAndVerifyFixedWorker,
  })
}

async function main() {
  if ((resume || supplement) && !real) throw new RealBudgetError('Acceptance resume and supplement require --real')
  if (supplement && (process.platform !== 'win32' || !arguments_.includes('--state-dir')
    || resolve(await realpath(state)).toLowerCase() !== resolve(supplementalState).toLowerCase())) {
    throw new RealBudgetError('The supplemental allowance requires the original E:/Codex/staging-acceptance/local-state directory')
  }
  if (supplement && process.env.DSH_NOVEL_PROVIDER_MODEL !== supplementalModel) {
    throw new RealBudgetError(`Supplemental real acceptance requires DSH_NOVEL_PROVIDER_MODEL=${supplementalModel}`)
  }
  if (real && (await readFile(join(state, 'secrets', 'deepseek-api-key'), 'utf8')).trim() === '') {
    throw new Error('Real acceptance requires a key in the local deepseek-api-key secret')
  }
  const ca = await readFile(join(state, 'local-ca.crt'), 'utf8')
  await mkdir(join(state, 'evidence'), { recursive: true })
  if (real) {
    const attempt = supplement ? (resume ? 'supplement-resume' : 'supplement') : resume ? 'resume' : 'attempt'
    const reportPath = join(state, 'evidence', `real-acceptance-${attempt}-${randomUUID()}.json`)
    let result: unknown, failureStage: string | undefined, passed = false, restorationFailed = false
    let images: Awaited<ReturnType<typeof imageEvidence>> | undefined, acknowledgedReservations: number | undefined
    try {
      if (supplement) {
        result = await supplementalRealFlow(ca, value => { images = value })
        acknowledgedReservations = 2
      }
      else if (resume) result = await resumedRealFlow(ca)
      else await withRealBudget(state, false, async lease => {
        try {
          await verifyRealPrerequisites(ca)
          await realFlow(ca, lease)
        } finally {
          try { await restoreAndVerifyFixedWorker() } catch {
            throw new RealBudgetError('Real acceptance fixed-model restoration failed; inspect the independent attempt report')
          }
        }
      })
      passed = true
    } catch (error) {
      failureStage = error instanceof ResumeFlowError || error instanceof SupplementFlowError ? error.stage : 'acceptance'
      if (error instanceof ResumeFlowError || error instanceof SupplementFlowError) result = error.locators
      if (error instanceof SupplementFlowError) {
        restorationFailed = error.restorationFailed
        acknowledgedReservations = error.submitted
      }
      evidence.push({ scenario: failureStage, status: 'failed' })
      throw error
    } finally {
      await writeFile(reportPath, JSON.stringify({ mode: 'real', resume, passed, recordedAt: new Date().toISOString(),
        ...(supplement ? { supplement, model: supplementalModel, restorationFailed, images, acknowledgedReservations } : {}),
        preparationProvider: resume && !supplement ? 'fixed-model' : 'real', failureStage, result, scenarios: evidence }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    }
  } else {
    await withAcceptanceLock(state, async () => {
      let images: Awaited<ReturnType<typeof imageEvidence>> | undefined
      try { await restoreFixedModelWorker(compose); images = await imageEvidence(); await mockFlow(ca) } finally {
        await writeFile(join(state, 'evidence/mock-acceptance.json'), JSON.stringify({ mode: 'mock', recordedAt: new Date().toISOString(), images, scenarios: evidence }, null, 2) + '\n')
      }
    })
  }
}

try { await main() } catch (error) {
  console.error(error instanceof RealBudgetError || error instanceof SupplementFlowError || error instanceof Error && (error.message.startsWith('Acceptance failed:') || error.message.startsWith('Real acceptance requires'))
    ? error.message : 'Local acceptance could not complete; inspect local services and the redacted evidence report.')
  process.exitCode = 1
}
