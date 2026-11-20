import { describe, expect, it } from 'vitest'
import { ProposalPublicationService } from '../src/index.ts'
import { owner } from './coverage-fixture.ts'

const proposalId = '1ce83391-e2f7-426a-898a-d41a298b36ef'
const targetId = '86b09fd4-f246-42f6-9bd6-9e35457aabbb'

function failingDatabase(failure: unknown) {
  let calls = 0
  return { db: { transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
    execute: async () => {
      calls++
      if (calls % 5 === 0) throw failure
      return { rows: [] }
    },
  }) } } as never
}

describe('publication service database errors', () => {
  it.each([
    ['P2001', 'not_found'], ['P2002', 'forbidden'], ['P2003', 'conflict'], ['P2004', 'invalid_request'],
  ])('converts only business SQLSTATE %s through driver causes', async (code, kind) => {
    const failure = new Error('driver query contains private SQL', { cause: new Error('transaction failed', {
      cause: Object.assign(new Error('private database message'), { code }),
    }) })
    const service = new ProposalPublicationService(failingDatabase(failure), owner)
    await expect(service.publish({ workspaceId: owner.workspaceId, proposalId }))
      .rejects.toMatchObject({ name: 'ProposalOperationError', kind })
    await expect(service.rollback({ workspaceId: owner.workspaceId, targetType: 'characters', targetId, versionNo: 1 }))
      .rejects.toMatchObject({ name: 'ProposalOperationError', kind })
  })

  it.each(['42501', '40001', '08006', 'P2099'])('preserves infrastructure/unknown SQLSTATE %s', async (code) => {
    const failure = Object.assign(new Error('database failed'), { code })
    const service = new ProposalPublicationService(failingDatabase(failure), owner)
    await expect(service.publish({ workspaceId: owner.workspaceId, proposalId })).rejects.toBe(failure)
  })

  it('does not loop on a cyclic driver cause', async () => {
    const failure = new Error('unknown driver failure')
    failure.cause = failure
    const service = new ProposalPublicationService(failingDatabase(failure), owner)
    await expect(service.publish({ workspaceId: owner.workspaceId, proposalId })).rejects.toBe(failure)
  })

  it('rejects a malformed proposal ID before opening a database transaction', async () => {
    const service = new ProposalPublicationService({} as never, owner)
    await expect(service.publish({ workspaceId: owner.workspaceId, proposalId: 'not-a-uuid' }))
      .rejects.toMatchObject({ name: 'ProposalOperationError', kind: 'invalid_request' })
  })

  it.each([[targetId, 0], [targetId, 2_147_483_648], ['not-a-uuid', 1]])('rejects invalid rollback target %s or version %d before opening a database transaction', async (id, versionNo) => {
    const service = new ProposalPublicationService({} as never, owner)
    await expect(service.rollback({ workspaceId: owner.workspaceId, targetType: 'characters', targetId: id, versionNo }))
      .rejects.toMatchObject({ name: 'ProposalOperationError', kind: 'invalid_request' })
  })
})
