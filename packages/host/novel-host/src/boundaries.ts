/** Request identity selection, provider credential isolation, and dependency readiness. */
import type { AuthHttpIdentity, AuthHttpRequest } from '@deepseek-ai/dsh-user-auth'

/** Persisted membership authority; onboarding is permitted only after successful login. */
export interface WorkspaceIdentityResolver {
  onboard(userId: string): Promise<AuthHttpIdentity | null>
  resolve(userId: string, hint?: string): Promise<AuthHttpIdentity | null>
  resolveForCredentials(userId: string, hint?: string): Promise<AuthHttpIdentity | null>
}

/**
 * Only a successful login may initialize workspace membership; request hints select existing authority.
 * @param resolver - Database-backed workspace membership operations.
 * @param request - Authentication route and optional workspace-selection header.
 * @returns An authentication identity callback restricted to the request's permitted operation.
 */
export function identityForRequest(
  resolver: WorkspaceIdentityResolver, request: AuthHttpRequest,
): (userId: string, sessionId: string) => Promise<AuthHttpIdentity | null> {
  const login = request.method.toUpperCase() === 'POST' && request.path === '/api/auth/login'
  const refresh = request.method.toUpperCase() === 'POST' && request.path === '/api/auth/refresh'
  return userId => login ? resolver.onboard(userId)
    : refresh ? resolver.resolveForCredentials(userId, request.headers['x-dsh-workspace-id'])
      : resolver.resolve(userId, request.headers['x-dsh-workspace-id'])
}

/**
 * The fixed internal fixture never receives an operator credential, even when one is installed.
 * @param url - Validated provider endpoint.
 * @param key - Operator credential for a real endpoint.
 * @returns The fixture credential or nonempty operator credential; missing real credentials throw.
 */
export function selectProviderKey(url: string, key: string): string {
  if (url === 'http://model:8081/v1') return 'fixture-only'
  if (key.trim() === '') throw new Error('novel-host: provider key is required')
  return key
}

/**
 * Probe infrastructure capabilities without exposing driver failures or contacting an AI provider.
 * @param checks - Named dependency probes that settle independently.
 * @returns Aggregate availability without dependency diagnostics.
 */
export async function checkReadiness(checks: Readonly<Record<string, () => Promise<unknown>>>): Promise<{ ready: boolean }> {
  const results = await Promise.allSettled(Object.values(checks).map(check => Promise.resolve().then(check)))
  return { ready: results.every(result => result.status === 'fulfilled') }
}
