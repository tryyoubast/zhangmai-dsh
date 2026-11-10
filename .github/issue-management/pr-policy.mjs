#!/usr/bin/env node

/** Read-only PR metadata check using the current repository's GitHub token. */
import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { requiresPullRequestPolicy, validatePullRequest } from './pr-metadata.mjs'

async function pullRequestApi(path) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 未设置')
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'dsh-pr-policy',
    },
  })
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

/**
 * Check live PR labels and review participation without reading its body or Issues.
 * @param {{pull_request: {number: number}}} event Pull-request or submitted-review event.
 * @returns {Promise<void>} Resolves for valid or exempt PRs; rejects policy and API failures.
 */
export async function runPullRequestCheck(event) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must be owner/repository')
  const base = `/repos/${repository}/pulls/${event.pull_request.number}`
  const [pull, requests, reviews] = await Promise.all([
    pullRequestApi(base),
    pullRequestApi(`${base}/requested_reviewers`),
    pullRequestApi(`${base}/reviews?per_page=100`),
  ])
  const metadata = {
    isDraft: pull.draft,
    authorType: pull.user?.type ?? 'User',
    reviewRequestCount: requests.users.length + requests.teams.length,
    reviewCount: reviews.length,
    labels: pull.labels.map(label => label.name),
  }
  const errors = validatePullRequest(metadata)
  if (errors.length > 0) {
    for (const error of errors) process.stdout.write(`::error::${error}\n`)
    throw new Error(`Issue policy 未通过，共 ${errors.length} 项`)
  }
  process.stdout.write(requiresPullRequestPolicy(metadata) ? 'Issue policy 通过。\n' : 'PR 尚未进入 Issue policy 强制范围。\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(async () => {
    if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH 未设置')
    await runPullRequestCheck(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')))
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
