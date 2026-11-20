import { describe, expect, it } from 'vitest'
import { ProposalOperationError } from '@deepseek-ai/dsh-novel-authoring'
import { owner } from '../../../storage/novel-authoring/tests/coverage-fixture.ts'
import { NovelAuthoringHttpController, type NovelAuthoringHttpServices } from '../src/index.ts'

function controller(failure: Error) {
  const services: NovelAuthoringHttpServices = {
    workspace: { createWorkspace: async () => 'workspace', listWorkspaces: async () => [], createNovel: async () => 'novel' },
    authoring: { createGenerationRun: async () => 'run', createDraftProposal: async () => 'proposal' },
    longform: { listContextItems: async () => [] },
    review: { review: async () => undefined, bindTarget: async () => undefined },
    publication: { publish: async () => { throw failure }, rollback: async () => { throw failure } },
  }
  return new NovelAuthoringHttpController(owner, services)
}

describe('publication and rollback HTTP errors', () => {
  for (const operation of ['publish', 'rollback']) {
    const request = { method: 'POST', path: `/api/proposals/proposal/${operation}`,
      body: { targetType: 'characters', targetId: 'target', versionNo: 1 } }

    it.each([
      ['not_found', 404], ['forbidden', 403], ['conflict', 409], ['invalid_request', 400],
    ] as const)(`${operation} maps classified %s without exposing cause`, async (kind, status) => {
      const failure = new ProposalOperationError(kind, { cause: new Error('secret SQL and connection details') })
      const result = await controller(failure).handle(request)
      expect(result.status).toBe(status)
      expect(result.body).toBe(JSON.stringify({ error: kind }))
    })

    it.each(['42501', '40001', '08006'])(`${operation} keeps unexpected database %s as a redacted 500`, async (code) => {
      const failure = Object.assign(new Error('workspace permission required; version conflict; private SQL'), { code })
      const result = await controller(failure).handle(request)
      expect(result.status).toBe(500)
      expect(result.body).toBe('{"error":"authoring_unavailable"}')
    })
  }

  it('keeps normalized publication paths on the same safe error mapping', async () => {
    const result = await controller(new Error('private permission required')).handle({
      method: 'POST', path: '/api//proposals/proposal/publish/', body: {},
    })
    expect(result.status).toBe(500)
    expect(result.body).toBe('{"error":"authoring_unavailable"}')
  })
})
