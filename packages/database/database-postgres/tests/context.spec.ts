import { describe, expect, it } from 'vitest'
import { requestContextSettings, withRequestContext } from '../src/database.ts'

describe('request database context', () => {
  it('maps authenticated identity to transaction-local PostgreSQL settings', () => {
    expect(requestContextSettings({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      actorType: 'agent',
      agentPrincipalId: 'agent-1',
    })).toEqual([
      ['app.user_id', 'user-1'],
      ['app.workspace_id', 'workspace-1'],
      ['app.actor_type', 'agent'],
      ['app.agent_principal_id', 'agent-1'],
    ])
  })

  it('clears an absent agent principal inside the transaction', () => {
    expect(requestContextSettings({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      actorType: 'user',
    })).toContainEqual(['app.agent_principal_id', ''])
  })

  it('sets context before invoking the transaction callback', async () => {
    const queries: unknown[] = []
    const fake = {
      db: {
        transaction: async (callback: (tx: { execute(query: unknown): Promise<void> }) => Promise<unknown>) => {
          const tx = { execute: async (query: unknown) => { queries.push(query) } }
          return callback(tx)
        },
      },
    }
    const result = await withRequestContext(fake as never, {
      userId: 'user-1',
      workspaceId: 'workspace-1',
      actorType: 'user',
    }, async () => 'ok')
    expect(result).toBe('ok')
    expect(queries).toHaveLength(4)
  })
})
