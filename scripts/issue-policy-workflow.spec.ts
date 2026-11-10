import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  name?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

function workflow(file: string): {
  on: Record<string, { types: string[] }>
  permissions: Record<string, string>
  jobs: Record<string, { name?: string; if?: string; steps: WorkflowStep[] }>
} {
  return yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows', file), 'utf8')) as ReturnType<typeof workflow>
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required workflow entry is missing')
  return value
}

describe('portable pull request metadata policy', () => {
  it('keeps the required check and event-SHA code on a read-only repository token', () => {
    const policy = workflow('issue-policy.yml')
    const policyJob = required(policy.jobs.policy)
    expect(policyJob.name).toBe('Issue policy')
    expect(policy.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    const checkout = required(policyJob.steps.find(step => step.uses?.startsWith('actions/checkout@')))
    expect(checkout.with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false })
    const validate = required(policyJob.steps.find(step => step.name === 'Validate pull request'))
    expect(validate.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}' })
    expect(validate.run).toBe('node .github/issue-management/pr-policy.mjs')
    expect(JSON.stringify(policy)).not.toMatch(/create-github-app-token|PROJECT_TOKEN|DSH_ISSUE_APP|secrets\./)
    expect(required(policy.on.pull_request).types).toContain('ready_for_review')
    expect(required(policy.on.pull_request_review).types).toEqual(['submitted'])
    expect(policy.on).not.toHaveProperty('pull_request_target')
  })

  it('checks optional Project configuration before minting a write token', () => {
    const lifecycle = workflow('issue-lifecycle.yml')
    const lifecycleJob = required(lifecycle.jobs.lifecycle)
    const steps = lifecycleJob.steps
    const preflight = required(steps.find(step => step.name === 'Validate Project configuration'))
    const token = required(steps.find(step => step.name === 'Create project token'))
    const handle = required(steps.find(step => step.name === 'Handle repository event'))
    expect(lifecycleJob.if).toBeUndefined()
    expect(steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.ref).toBe('${{ github.event.repository.default_branch }}')
    for (const step of [preflight, token, handle]) {
      expect(step?.if).toContain("vars.DSH_ISSUE_PROJECT_ENABLED == 'true'")
      expect(step?.if).toContain("!= 'Bot'")
      expect(step?.if).toContain("!= 'App'")
      expect(step?.if).toContain("github.event.review.state == 'changes_requested'")
    }
    expect(preflight.run).toBe('node .github/issue-management/policy.mjs validate-config')
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(token))
    expect(preflight.env).toBeUndefined()
    expect(handle.env?.DSH_ISSUE_PROJECT_ENABLED).toBe('${{ vars.DSH_ISSUE_PROJECT_ENABLED }}')
    expect(token.with?.owner).toBe('${{ github.repository_owner }}')
    expect(token.with?.repositories).toBe('${{ github.event.repository.name }}')
    expect(required(lifecycle.on.issues).types).not.toContain('field_added')
    expect(required(lifecycle.on.issues).types).not.toContain('field_removed')
    expect(required(lifecycle.on.pull_request).types).not.toContain('ready_for_review')
  })
})
