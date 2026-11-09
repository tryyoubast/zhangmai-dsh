/** Controlled adapter replies for service tests; domain assertions use captured writes and committed results. */
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'

export const editor: AuthPrincipal = {
  userId: 'user', sessionId: 'session', workspaceId: 'workspace', clientType: 'browser', roles: ['editor'], actorType: 'user',
}
export const worker: AuthPrincipal = { ...editor, actorType: 'agent', agentPrincipalId: 'agent' }
export const owner: AuthPrincipal = { ...editor, roles: ['owner'] }
export type Row = Record<string, unknown>

export function serviceDatabase() {
  const selects: Row[][] = []
  const inserts: Row[][] = []
  const writes: Array<{ table: unknown; values: unknown; operation: string }> = []
  const executes: unknown[] = []
  const executionReplies = new Map<number, Row[]>()
  let transactions = 0
  let rollbacks = 0

  function selection() {
    const chain = {
      from: (_table: unknown) => chain,
      where: (_predicate: unknown) => chain,
      limit: (_limit: number) => chain,
      orderBy: (..._columns: unknown[]) => chain,
      for: (_mode: string) => chain,
      then: (resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(selects.shift() ?? []).then(resolve, reject),
    }
    return chain
  }
  function mutation(table: unknown, operation: string) {
    const chain = {
      values: (values: unknown) => { writes.push({ table, values, operation }); return chain },
      set: (values: unknown) => { writes.push({ table, values, operation }); return chain },
      where: (_predicate: unknown) => chain,
      onConflictDoNothing: (_config: unknown) => chain,
      returning: (_projection?: unknown) => chain,
      then: (resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(inserts.shift() ?? [{ id: 'created' }]).then(resolve, reject),
    }
    return chain
  }
  const transaction = {
    select: (_projection?: unknown) => selection(),
    insert: (table: unknown) => mutation(table, 'insert'),
    update: (table: unknown) => mutation(table, 'update'),
    execute: async (query: unknown) => {
      executes.push(query)
      return { rows: executionReplies.get(executes.length) ?? [] }
    },
  }
  const database = {
    db: {
      ...transaction,
      transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> => {
        transactions += 1
        try { return await callback(transaction) } catch (error) { rollbacks += 1; throw error }
      },
    },
    pool: {},
  }
  return {
    database: database as never, selects, inserts, writes, executes, executionReplies,
    get transactions() { return transactions }, get rollbacks() { return rollbacks },
  }
}
