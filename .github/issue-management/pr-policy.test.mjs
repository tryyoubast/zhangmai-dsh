import assert from 'node:assert/strict'
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const entry = new URL('./pr-policy.mjs', import.meta.url)

async function loadPolicy() {
  assert.ok(existsSync(entry), 'mandatory PR policy has its own entry point')
  return import(entry.href)
}

function mockPullRequestApi(t, { draft = false, author = 'User', requested = 1, reviews = 0, labels = ['kind/feature', 'area/web'], body = '' } = {}) {
  const paths = []
  const previous = { ...process.env }
  process.env.GITHUB_REPOSITORY = 'contributor/fork'
  process.env.GITHUB_TOKEN = 'repository-read-token'
  process.env.GH_TOKEN = 'unrelated-write-token'
  process.env.PROJECT_TOKEN = 'forbidden-project-token'
  t.after(() => {
    for (const key of ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GH_TOKEN', 'PROJECT_TOKEN']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer repository-read-token')
    assert.equal(options.method ?? 'GET', 'GET')
    const path = new URL(url).pathname + new URL(url).search
    paths.push(path)
    if (path === '/repos/contributor/fork/pulls/42') {
      return Response.json({ draft, user: { type: author }, labels: labels.map(name => ({ name })), body })
    }
    if (path === '/repos/contributor/fork/pulls/42/requested_reviewers') {
      return Response.json({ users: Array.from({ length: requested }, () => ({})), teams: [] })
    }
    if (path === '/repos/contributor/fork/pulls/42/reviews?per_page=100') return Response.json(Array.from({ length: reviews }, () => ({})))
    assert.fail(`policy must not read Issues or Projects: ${path}`)
  })
  return paths
}

test('accepts reviewed human metadata with no Issue references and no Issue or Project API access', async (t) => {
  const { runPullRequestCheck } = await loadPolicy()
  const paths = mockPullRequestApi(t)
  await runPullRequestCheck({ pull_request: { number: 42 } })
  assert.deepEqual(paths.sort(), [
    '/repos/contributor/fork/pulls/42',
    '/repos/contributor/fork/pulls/42/requested_reviewers',
    '/repos/contributor/fork/pulls/42/reviews?per_page=100',
  ])
})

test('ignores resolving Issue text and Project priority when checking labels', async (t) => {
  const { runPullRequestCheck } = await loadPolicy()
  mockPullRequestApi(t, { body: 'Fixes #123\nRelated owner/other#999', labels: ['kind/doc', 'area/infra', 'p3'] })
  await runPullRequestCheck({ pull_request: { number: 42 } })
})

test('enforces labels after a submitted review even without outstanding review requests', async (t) => {
  const { runPullRequestCheck } = await loadPolicy()
  mockPullRequestApi(t, { requested: 0, reviews: 1, labels: [] })
  await assert.rejects(runPullRequestCheck({ pull_request: { number: 42 } }), /Issue policy/)
})

for (const state of [{ draft: true }, { author: 'Bot' }, { author: 'App' }, { requested: 0 }]) {
  test(`exempts ${JSON.stringify(state)} without Issue or Project API access`, async (t) => {
    const { runPullRequestCheck } = await loadPolicy()
    mockPullRequestApi(t, { ...state, labels: [] })
    await runPullRequestCheck({ pull_request: { number: 42 } })
  })
}

test('loads the mandatory policy without optional Project configuration', async (t) => {
  await loadPolicy()
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-pr-policy-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  for (const file of ['pr-policy.mjs', 'pr-metadata.mjs']) copyFileSync(new URL(file, import.meta.url), join(temporary, file))
  const isolated = await import(pathToFileURL(join(temporary, 'pr-policy.mjs')).href)
  assert.equal(typeof isolated.runPullRequestCheck, 'function')
})
