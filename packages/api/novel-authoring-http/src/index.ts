import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  AuthHttpRequest,
  AuthHttpResponse,
  AuthPrincipal,
} from '@deepseek-ai/dsh-user-auth'
import type {
  DraftProposalInput,
  GenerationRunInput,
  LongformAuthoringService,
  NovelGenerationWorkflowService,
  NovelGenerationWorkflowInput,
  NovelAuthoringService,
  NovelCreateInput,
  ProposalPublicationService,
  ProposalReviewService,
  ProposalRollbackInput,
  WorkspaceAuthoringService,
} from '@deepseek-ai/dsh-novel-authoring'

/** The controller method required by the WebServer adapter. */
export interface PlatformHttpControllerLike {
  /** Dispatch one already-bounded HTTP request. */
  handle(request: AuthHttpRequest): Promise<AuthHttpResponse | NovelAuthoringHttpResponse>
}

/** Web adapter configuration. */
export interface Config {
  /** Maximum JSON request body size in bytes. */
  readonly maxBodyBytes: number
}

/** Default request body ceiling for browser and official-client API calls. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

/** Cordis function-plugin name. */
export const name = 'novel-authoring-http'

/** Services supplied by the composing Host application. */
export const inject = ['webServer', 'platformHttpController']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Platform controller carrying authentication and authoring routes. */
    platformHttpController: PlatformHttpControllerLike
  }
}

export interface NovelAuthoringHttpRequest {
  readonly method: string
  readonly path: string
  readonly body?: unknown
}

export interface NovelAuthoringHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Collect a request body without allowing it to exceed the configured limit. */
async function readBoundedBody(request: IncomingMessage, maxBodyBytes: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.byteLength
    if (size > maxBodyBytes) {
      request.resume()
      return null
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function requestHeaders(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

function writeHttpResponse(response: ServerResponse, value: AuthHttpResponse | NovelAuthoringHttpResponse): void {
  response.statusCode = value.status
  for (const [name, header] of Object.entries(value.headers)) response.setHeader(name, header)
  response.end(value.body)
}

function writeAdapterError(response: ServerResponse, status: 400 | 413, error: 'invalid_request' | 'payload_too_large'): void {
  writeHttpResponse(response, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error }),
  })
}

/** Register the `/api` route on the repository WebServer without owning SPA fallback. */
export function apply(ctx: Context, config: Config = { maxBodyBytes: DEFAULT_MAX_BODY_BYTES }): void {
  if (!Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes < 1) {
    throw new Error('novel-authoring-http: maxBodyBytes must be a positive safe integer')
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api',
    handler: async (request, response) => {
      let body: unknown
      try {
        const text = await readBoundedBody(request, config.maxBodyBytes)
        if (text === null) {
          writeAdapterError(response, 413, 'payload_too_large')
          return
        }
        if (text !== '') {
          try {
            body = JSON.parse(text) as unknown
          } catch {
            writeAdapterError(response, 400, 'invalid_request')
            return
          }
        }
      } catch {
        writeAdapterError(response, 400, 'invalid_request')
        return
      }
      const path = new URL(request.url ?? '/', 'http://dsh.invalid').pathname
      const remoteAddress = request.socket?.remoteAddress
      const platformHttpController = ctx.get('platformHttpController') as PlatformHttpControllerLike | undefined
      if (platformHttpController === undefined) {
        throw new Error('novel-authoring-http: platformHttpController is unavailable')
      }
      const result = await platformHttpController.handle({
        method: request.method ?? 'GET',
        path,
        headers: requestHeaders(request),
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
        ...(body === undefined ? {} : { body }),
      })
      writeHttpResponse(response, result)
    },
  }), 'novel-authoring-http: /api')
}

/** Host-owned composition seam that joins authentication and authoring routes. */
export interface PlatformHttpServices {
  readonly auth: { handle(request: AuthHttpRequest): Promise<AuthHttpResponse> }
  readonly resolvePrincipal: (request: AuthHttpRequest) => Promise<AuthPrincipal | null>
  readonly authoring: (principal: AuthPrincipal) => NovelAuthoringHttpServices
}

export interface NovelAuthoringHttpServices {
  readonly workspace: Pick<WorkspaceAuthoringService, 'createWorkspace' | 'listWorkspaces' | 'createNovel'> & Partial<Pick<WorkspaceAuthoringService, 'inviteMember' | 'changeMemberRole' | 'revokeMember' | 'listMembers' | 'transferOwnership' | 'archiveWorkspace' | 'restoreWorkspace'>>
  readonly authoring: Pick<NovelAuthoringService, 'createGenerationRun' | 'createDraftProposal'>
  readonly generation?: Pick<NovelGenerationWorkflowService, 'generate'>
  readonly longform: Pick<LongformAuthoringService, 'listContextItems'>
  readonly review: Pick<ProposalReviewService, 'review' | 'bindTarget'>
  readonly publication: Pick<ProposalPublicationService, 'publish' | 'rollback'>
}

function response(status: number, body: Record<string, unknown>): NovelAuthoringHttpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }
}

function bodyOf(request: NovelAuthoringHttpRequest): Record<string, unknown> {
  if (request.body === undefined || request.body === null) return {}
  if (typeof request.body === 'string') {
    try {
      const value = JSON.parse(request.body) as unknown
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {}
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' && value[key].trim() !== '' ? value[key] as string : null
}

function memberRole(value: Record<string, unknown>): 'admin' | 'editor' | 'member' | null {
  const role = stringField(value, 'role')
  return role === 'admin' || role === 'editor' || role === 'member' ? role : null
}

function pathParts(path: string): string[] {
  return new URL(path, 'https://dsh.invalid').pathname.split('/').filter(Boolean)
}

function jsonBody(responseValue: unknown, status = 200): NovelAuthoringHttpResponse {
  return response(status, { ok: true, ...typeof responseValue === 'object' && responseValue !== null ? responseValue : { id: responseValue } })
}

function unauthorized(): NovelAuthoringHttpResponse {
  return response(401, { error: 'unauthorized' })
}

/**
 * Framework-neutral host boundary for the complete platform API. Authentication
 * routes stay public; all authoring routes require a server-resolved principal.
 */
export class PlatformHttpController {
  constructor(private readonly services: PlatformHttpServices) {}

  async handle(request: AuthHttpRequest): Promise<AuthHttpResponse | NovelAuthoringHttpResponse> {
    if (request.path.startsWith('/api/auth/')) return this.services.auth.handle(request)
    const principal = await this.services.resolvePrincipal(request)
    if (principal === null) return unauthorized()
    return new NovelAuthoringHttpController(principal, this.services.authoring(principal)).handle({
      method: request.method,
      path: request.path,
      body: request.body,
    })
  }
}

/**
 * HTTP adapter for the authoring domain. Authentication and principal
 * resolution happen before this adapter is called.
 */
export class NovelAuthoringHttpController {
  constructor(
    private readonly principal: AuthPrincipal,
    private readonly services: NovelAuthoringHttpServices,
  ) {}

  async handle(request: NovelAuthoringHttpRequest): Promise<NovelAuthoringHttpResponse> {
    try {
      const method = request.method.toUpperCase()
      const parts = pathParts(request.path)
      const body = bodyOf(request)
      if (method === 'POST' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'workspaces') {
        const name = stringField(body, 'name')
        if (name === null) return response(400, { error: 'invalid_request' })
        return jsonBody(await this.services.workspace.createWorkspace({ name }))
      }
      if (method === 'GET' && parts.join('/') === 'api/workspaces') {
        return jsonBody({ workspaces: await this.services.workspace.listWorkspaces() })
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[3] === 'members') {
        const userId = stringField(body, 'userId')
        const role = memberRole(body)
        if (userId === null || role === null || this.services.workspace.inviteMember === undefined) return response(404, { error: 'not_found' })
        await this.services.workspace.inviteMember(this.workspace(parts[2] ?? ''), userId, role)
        return jsonBody({ status: 'invited' })
      }
      if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[3] === 'members') {
        if (this.services.workspace.listMembers === undefined) return response(404, { error: 'not_found' })
        return jsonBody({ members: await this.services.workspace.listMembers(this.workspace(parts[2] ?? '')) })
      }
      if (method === 'PATCH' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[3] === 'members') {
        const role = memberRole(body)
        if (role === null || this.services.workspace.changeMemberRole === undefined) return response(404, { error: 'not_found' })
        await this.services.workspace.changeMemberRole(this.workspace(parts[2] ?? ''), parts[4] ?? '', role)
        return jsonBody({ status: 'updated' })
      }
      if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[3] === 'members') {
        if (this.services.workspace.revokeMember === undefined) return response(404, { error: 'not_found' })
        await this.services.workspace.revokeMember(this.workspace(parts[2] ?? ''), parts[4] ?? '')
        return jsonBody({ status: 'revoked' })
      }
      if (method === 'POST' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[2] !== '') {
        const action = stringField(body, 'action')
        const workspaceId = this.workspace(parts[2] ?? '')
        if (action === 'transfer-ownership' && this.services.workspace.transferOwnership !== undefined) {
          const userId = stringField(body, 'userId')
          if (userId === null) return response(400, { error: 'invalid_request' })
          await this.services.workspace.transferOwnership(workspaceId, userId)
          return jsonBody({ status: 'transferred' })
        }
        if (action === 'archive' && this.services.workspace.archiveWorkspace !== undefined) {
          await this.services.workspace.archiveWorkspace(workspaceId)
          return jsonBody({ status: 'archived' })
        }
        if (action === 'restore' && this.services.workspace.restoreWorkspace !== undefined) {
          await this.services.workspace.restoreWorkspace(workspaceId)
          return jsonBody({ status: 'active' })
        }
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[3] === 'novels') {
        const title = stringField(body, 'title')
        if (title === null) return response(400, { error: 'invalid_request' })
        const input: NovelCreateInput = { workspaceId: this.workspace(parts[2] ?? ''), title }
        return jsonBody(await this.services.workspace.createNovel(input))
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'novels' && parts[3] === 'generation-runs') {
        const instruction = stringField(body, 'instruction')
        const contextLimit = typeof body.contextLimit === 'number' ? body.contextLimit : 8
        const input: GenerationRunInput = {
          workspaceId: this.workspace(stringField(body, 'workspaceId') ?? ''),
          novelId: parts[2] ?? '',
          model: stringField(body, 'model') ?? 'configured-provider',
          promptVersion: stringField(body, 'promptVersion') ?? 'v1',
          sourceSessionId: stringField(body, 'sourceSessionId') ?? '00000000-0000-0000-0000-000000000000',
          idempotencyKey: stringField(body, 'idempotencyKey') ?? '',
          ...(instruction === null ? {} : { instruction }),
          contextLimit,
        }
        if (input.idempotencyKey === '' || instruction === null
          || !Number.isSafeInteger(contextLimit) || contextLimit < 0 || contextLimit > 128) {
          return response(400, { error: 'invalid_request' })
        }
        return jsonBody(await this.services.authoring.createGenerationRun(input))
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'novels' && parts[3] === 'generate') {
        const novelId = parts[2]
        if (novelId === undefined || novelId === '') {
          return response(404, { error: 'not_found' })
        }
        const instruction = stringField(body, 'instruction')
        const idempotencyKey = stringField(body, 'idempotencyKey')
        const workspaceId = this.workspace(stringField(body, 'workspaceId') ?? '')
        const limit = typeof body.limit === 'number' ? body.limit : 8
        if (instruction === null || idempotencyKey === null || !Number.isSafeInteger(limit) || limit < 0) {
          return response(400, { error: 'invalid_request' })
        }
        const generationInput = {
          workspaceId,
          novelId,
          model: stringField(body, 'model') ?? 'configured-provider',
          promptVersion: stringField(body, 'promptVersion') ?? 'v1',
          sourceSessionId: stringField(body, 'sourceSessionId') ?? '00000000-0000-0000-0000-000000000000',
          idempotencyKey,
          instruction,
          contextLimit: limit,
        }
        if (this.principal.actorType !== 'agent') {
          const runId = await this.services.authoring.createGenerationRun(generationInput)
          return jsonBody({ runId, status: 'queued' }, 202)
        }
        if (!this.services.generation) return response(404, { error: 'not_found' })
        const input: NovelGenerationWorkflowInput = {
          ...generationInput,
          instruction,
          limit,
        }
        return jsonBody(await this.services.generation.generate(input))
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'novels' && parts[3] === 'proposals') {
        if (this.principal.actorType !== 'agent') return response(404, { error: 'not_found' })
        const targetId = stringField(body, 'targetId')
        const baseVersionNo = typeof body.baseVersionNo === 'number' ? body.baseVersionNo : undefined
        const conflictResult = typeof body.conflictResult === 'object' && body.conflictResult !== null && !Array.isArray(body.conflictResult) ? body.conflictResult as Record<string, unknown> : undefined
        const input: DraftProposalInput = {
          generationRunId: stringField(body, 'generationRunId') ?? '',
          workspaceId: this.workspace(stringField(body, 'workspaceId') ?? ''),
          novelId: parts[2] ?? '',
          targetType: stringField(body, 'targetType') as DraftProposalInput['targetType'],
          operation: (stringField(body, 'operation') ?? 'create') as DraftProposalInput['operation'],
          proposedContent: typeof body.proposedContent === 'object' && body.proposedContent !== null && !Array.isArray(body.proposedContent) ? body.proposedContent as Record<string, unknown> : {},
          validationResult: typeof body.validationResult === 'object' && body.validationResult !== null && !Array.isArray(body.validationResult) ? body.validationResult as Record<string, unknown> : {},
          idempotencyKey: stringField(body, 'idempotencyKey') ?? '',
          ...(targetId === null ? {} : { targetId }),
          ...(baseVersionNo === undefined ? {} : { baseVersionNo }),
          ...(conflictResult === undefined ? {} : { conflictResult }),
        }
        if (input.generationRunId === '' || input.targetType === undefined || input.idempotencyKey === '') return response(400, { error: 'invalid_request' })
        return jsonBody(await this.services.authoring.createDraftProposal(input))
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'proposals' && parts[3] === 'review') {
        const decision = stringField(body, 'decision') as 'approved' | 'rejected' | 'expired' | 'draft' | null
        if (decision === null || !['approved', 'rejected', 'expired', 'draft'].includes(decision)) return response(400, { error: 'invalid_request' })
        await this.services.review.review({ workspaceId: this.principal.workspaceId, proposalId: parts[2] ?? '', decision })
        return jsonBody({ status: decision })
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'proposals' && parts[3] === 'publish') {
        await this.services.publication.publish({ workspaceId: this.principal.workspaceId, proposalId: parts[2] ?? '' })
        return jsonBody({ status: 'published' })
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'proposals' && parts[3] === 'rollback') {
        const targetType = stringField(body, 'targetType')
        const targetId = stringField(body, 'targetId')
        const versionNo = body.versionNo
        if (targetType === null || targetId === null || typeof versionNo !== 'number') return response(400, { error: 'invalid_request' })
        const input: ProposalRollbackInput = { workspaceId: this.principal.workspaceId, targetType, targetId, versionNo }
        await this.services.publication.rollback(input)
        return jsonBody({ status: 'rolled_back' })
      }
      if (method === 'GET' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'novels' && parts[3] === 'context') {
        return jsonBody({ context: await this.services.longform.listContextItems(this.principal.workspaceId, parts[2] ?? '', parts[4] ?? '') })
      }
      return response(404, { error: 'not_found' })
    } catch (error) {
      if (error instanceof Error && /permission|required|context mismatch|invalid|workspace/i.test(error.message)) return response(403, { error: 'forbidden' })
      if (error instanceof Error && /version conflict|already exists|idempotency/i.test(error.message)) return response(409, { error: 'conflict' })
      return response(500, { error: 'authoring_unavailable' })
    }
  }

  private workspace(workspaceId: string): string {
    if (workspaceId !== this.principal.workspaceId) throw new Error('workspace context mismatch')
    return workspaceId
  }
}
