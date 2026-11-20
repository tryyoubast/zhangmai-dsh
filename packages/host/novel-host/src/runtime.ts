/** Compose real auth, authoring, provider, and persistence classes under separately restricted pools. */
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AuthHttpController, AuthSecurityControls, AuthTemplateMailProvider, PostgresAuthStore,
  RedisAuthRateLimiter, RefreshTokenService, UserAuthService, resolveAuthPrincipal,
  type AuthHttpRequest, type AuthHttpResponse, type AuthPrincipal,
} from '@deepseek-ai/dsh-user-auth'
import {
  PlatformHttpController, type NovelAuthoringHttpServices,
} from '@deepseek-ai/dsh-api-novel-authoring-http'
import {
  createDatabase, sql, withRequestContext, type DatabaseClient, type DatabaseRuntimeRole, type DshDatabase,
} from '@deepseek-ai/dsh-database-postgres'
import {
  DeepSeekNovelGenerationAdapter, GenerationMaterializationService, LongformAuthoringService, LongformGenerationService,
  NovelAuthoringService, NovelGenerationWorkflowService, PostgresGenerationResultRepository, PostgresGenerationWorkerIdentity,
  PostgresNovelContextRepository, PostgresWorkspaceIdentity, ProposalPublicationService, ProposalReviewService, WorkspaceAuthoringService,
} from '@deepseek-ai/dsh-novel-authoring'
import type { Redis } from 'ioredis'
import type { Transporter } from 'nodemailer'
import { identityForRequest, selectProviderKey } from './boundaries.ts'
import type { Config } from './config.ts'
import { deliverGeneration } from './queue.ts'

/**
 * Read a fixed host-owned secret name, keeping filesystem and secret contents out of errors.
 * @param directory - Operator-mounted secret directory.
 * @param name - Host-selected secret filename, never request input.
 * @returns Trimmed nonempty secret text; unavailable or empty files throw a redacted error.
 */
export async function readSecret(directory: string, name: string): Promise<string> {
  try {
    const value = (await readFile(join(directory, name), 'utf8')).trim()
    if (value === '') throw new Error('empty')
    return value
  } catch {
    throw new Error(`novel-host: required secret ${name} is unavailable`)
  }
}

/**
 * Create one restricted pool; the database package validates login-role isolation on checkout.
 * @param config - Validated database, secret, and process settings.
 * @param kind - Runtime principal whose own password file is read.
 * @returns A pool that assumes only the selected restricted runtime role.
 */
export async function openDatabase(config: Config, kind: 'auth' | 'app' | 'service' | 'worker'): Promise<DatabaseClient<DshDatabase>> {
  const password = await readSecret(config.secretDirectory, `${kind}-password`)
  const settings = config.database
  const url = new URL('postgresql://localhost')
  url.hostname = settings.host
  url.port = String(settings.port)
  url.pathname = `/${settings.name}`
  url.username = settings[`${kind}User`]
  url.password = password
  return createDatabase({
    url: url.href, runtimeRole: `dsh_${kind}_runtime`, maxConnections: settings.maxConnections,
    idleTimeoutMs: settings.idleTimeoutMs, connectionTimeoutMs: settings.connectionTimeoutMs,
    applicationName: `dsh-novel-${config.mode}-${kind}`,
  })
}

/**
 * Check required catalog capabilities without reading the private migration journal.
 * @param database - Restricted pool whose current role and required schema are checked.
 * @param role - Expected runtime role; mismatch or absent capabilities throw.
 */
export async function checkDatabase(database: DatabaseClient<DshDatabase>, role: DatabaseRuntimeRole): Promise<void> {
  const result = await database.db.execute<{ role: string; ready: boolean }>(sql`
    SELECT current_user AS role,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'current_user_workspace_memberships' AND p.pronargs = 0)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'ai' AND p.proname = 'resolve_generation_run_worker_identity' AND p.pronargs = 2
          AND p.prosecdef AND p.proargtypes = '2950 2950'::oidvector)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'ai' AND p.proname = 'settle_generation_run_without_authority' AND p.pronargs = 2
          AND p.prosecdef AND p.proargtypes = '2950 2950'::oidvector
          AND has_function_privilege('dsh_worker_runtime', p.oid, 'EXECUTE'))
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname = 'ai_runs_worker_claim_read')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'novel' AND p.proname = 'rollback_context_active' AND p.pronargs = 0
          AND NOT p.prosecdef
          AND has_function_privilege('dsh_app_runtime', p.oid, 'EXECUTE')
          AND has_function_privilege('dsh_worker_runtime', p.oid, 'EXECUTE'))
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'agent_run_allowed' AND p.pronargs = 3
          AND p.prosecdef AND p.proargtypes = '2950 2950 2950'::oidvector
          AND has_function_privilege('dsh_app_runtime', p.oid, 'EXECUTE')
          AND has_function_privilege('dsh_service_runtime', p.oid, 'EXECUTE'))
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'ai' AND c.relname = 'generation_runs' AND a.attname = 'instruction' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'ai.generation_proposals'::regclass AND t.tgname = 'generation_proposals_sync_candidate'
          AND t.tgenabled = 'O' AND NOT p.prosecdef)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'ai.generation_proposals'::regclass AND t.tgname = 'generation_proposals_require_published_target'
          AND t.tgenabled = 'O' AND NOT p.prosecdef)
      AND (SELECT count(*) = 8 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'novel' AND c.relname IN (
          'character_versions_history_no_idx','skill_versions_history_no_idx','location_versions_history_no_idx',
          'faction_versions_history_no_idx','item_versions_history_no_idx','storyline_versions_history_no_idx',
          'entity_relation_versions_history_no_idx','character_skill_versions_history_no_idx')
          AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL)
      AND (SELECT count(*) = 6 FROM pg_catalog.pg_policy p
        JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'novel' AND p.polname = c.relname || '_service_read'
          AND c.relname IN ('outlines','chapters','chapter_versions','chapter_summaries','story_facts','timeline_events')
          AND p.polcmd = 'r' AND 'dsh_service_runtime'::regrole::oid = ANY(p.polroles))
      AS ready
  `)
  const row = result.rows[0]
  if (row?.role !== role || !row.ready) throw new Error('novel-host: required database capabilities are unavailable')
}

/**
 * Assemble per-request authentication and principal-bound domain services without accepting request authority.
 * @param config - Validated authentication, email, queue, and secret settings.
 * @param databases - Separately restricted auth, app, and publication service pools.
 * @param redis - Connected rate-limit and generation-notification client.
 * @param mail - SMTP delivery transport.
 * @returns The platform controller with database-backed membership resolution.
 */
export async function createApiController(config: Config, databases: {
  readonly auth: DatabaseClient<DshDatabase>
  readonly app: DatabaseClient<DshDatabase>
  readonly service: DatabaseClient<DshDatabase>
}, redis: Redis, mail: Transporter): Promise<PlatformHttpController> {
  let privateKey
  let publicKey
  try {
    privateKey = createPrivateKey(await readSecret(config.secretDirectory, 'access-private.pem'))
    publicKey = createPublicKey(await readSecret(config.secretDirectory, 'access-public.pem'))
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519'
      || !createPublicKey(privateKey).equals(publicKey)) throw new Error('invalid pair')
  } catch {
    throw new Error('novel-host: Ed25519 access key pair is unavailable')
  }
  const authStore = new PostgresAuthStore(databases.auth)
  const auth = new UserAuthService(authStore, config.auth)
  const refresh = new RefreshTokenService(authStore, undefined, config.auth.refreshTtlMs)
  const identities = new PostgresWorkspaceIdentity(databases.app)
  const accessToken = {
    privateKey, publicKey, issuer: config.auth.issuer, audience: config.auth.audience, ttlSeconds: config.auth.accessTtlSeconds,
  }
  const security = new AuthSecurityControls(
    new RedisAuthRateLimiter({ send: (command, ...args) => redis.call(command, ...args) }),
    new AuthTemplateMailProvider({
      async send(input) {
        await mail.sendMail({
          from: config.smtp.from, to: input.to, subject: input.template,
          text: `${input.template}\nToken: ${input.token}\nExpires: ${input.expiresAt.toISOString()}\n`,
        })
      },
    }),
  )
  return new PlatformHttpController({
    allowedOrigin: config.origin,
    auth: {
      handle: request => new AuthHttpController(auth, refresh, {
        allowedOrigin: config.origin, security, sessionResolver: authStore, accessToken,
        resolveIdentity: identityForRequest(identities, request),
      }).handle(request),
    },
    resolvePrincipal: (request, restoreWorkspaceId) => resolveAuthPrincipal({
      headers: request.headers, sessionResolver: authStore, accessToken,
      resolveIdentity: async (userId) => {
        if (restoreWorkspaceId !== undefined) {
          return await identities.resolveForRestore(userId, restoreWorkspaceId) ?? identities.resolve(userId, restoreWorkspaceId)
        }
        return identities.resolve(userId, request.headers['x-dsh-workspace-id'])
      },
    }),
    authoring: principal => apiAuthoring(principal, databases, redis, config),
  })
}

function apiAuthoring(principal: AuthPrincipal, databases: {
  readonly app: DatabaseClient<DshDatabase>
  readonly service: DatabaseClient<DshDatabase>
}, redis: Redis, config: Config): NovelAuthoringHttpServices {
  return {
    workspace: new WorkspaceAuthoringService(databases.app, principal),
    authoring: new NovelAuthoringService(databases.app, principal),
    longform: new LongformAuthoringService(databases.app, principal),
    review: new ProposalReviewService(databases.app, principal),
    publication: new ProposalPublicationService(databases.service, principal),
    notifyGeneration: async (locator) => {
      await redis.call('XADD', config.redis.stream, '*', 'workspaceId', locator.workspaceId, 'generationRunId', locator.generationRunId)
    },
  }
}

/**
 * Construct generation services for each freshly resolved worker principal; provider calls are not retried.
 * @param database - Restricted worker pool with persisted identity lookup access.
 * @param adapter - Configured generation provider.
 * @returns A locator-only delivery operation that determines acknowledgement from persisted status.
 */
export function createWorkerDelivery(database: DatabaseClient<DshDatabase>, adapter: DeepSeekNovelGenerationAdapter): (fields: readonly string[]) => Promise<'ack' | 'retain'> {
  const agentPrincipalId = 'novel-worker'
  const identities = new PostgresGenerationWorkerIdentity(database, agentPrincipalId)
  return fields => deliverGeneration(fields, {
    resolve: locator => identities.resolve(locator),
    settleUnavailable: locator => withRequestContext(database, {
      userId: '', workspaceId: locator.workspaceId, actorType: 'agent', agentPrincipalId,
    }, async (db) => {
      const result = await db.execute<{ acknowledge: boolean }>(sql`
        SELECT ai.settle_generation_run_without_authority(
          ${locator.workspaceId}::uuid, ${locator.generationRunId}::uuid
        ) AS acknowledge
      `)
      return result.rows[0]?.acknowledge === true ? 'ack' : 'retain'
    }),
    interrupt: async (locator, identity) => {
      await new NovelAuthoringService(database, identity.principal).updateGenerationRunStatus({
        ...locator, status: 'failed', errorCode: 'GENERATION_INTERRUPTED', errorSummary: 'Generation was interrupted; submit a new request to continue.',
      })
    },
    execute: async (locator, identity) => {
      const principal = identity.principal
      const authoring = new NovelAuthoringService(database, principal)
      const longform = new LongformAuthoringService(database, principal)
      const generation = new LongformGenerationService({
        candidateRepository: new PostgresNovelContextRepository(database, principal),
        contextWriter: longform, contextReader: longform, adapter,
        resultRepository: new PostgresGenerationResultRepository(database, principal),
      })
      const materialization = new GenerationMaterializationService({
        createDraftProposal: input => authoring.createDraftProposal(input),
        createCharacterDraft: input => authoring.createCharacterDraft(input),
        createSkillDraft: input => authoring.createSkillDraft(input),
        createLocationDraft: input => authoring.createLocationDraft(input),
        createFactionDraft: input => authoring.createFactionDraft(input),
        createItemDraft: input => authoring.createItemDraft(input),
        createStorylineDraft: input => authoring.createStorylineDraft(input),
        createOutlineDraft: input => authoring.createOutlineDraft(input),
        createEntityRelationDraft: input => authoring.createEntityRelationDraft(input),
        createCharacterSkillDraft: input => authoring.createCharacterSkillDraft(input),
        createStoryFactDraft: input => authoring.createStoryFactDraft(input),
        createTimelineEventDraft: input => authoring.createTimelineEventDraft(input),
        createChapterDraft: input => longform.createChapterDraft(input),
        createChapterVersionDraft: input => longform.createChapterVersionDraft(input),
        createChapterSummaryDraft: input => authoring.createChapterSummaryDraft(input),
      })
      await new NovelGenerationWorkflowService({ authoring, generation, materialization }).executeQueued(locator)
    },
  })
}

/**
 * Load a real provider secret only for real endpoints; the fixture uses a fixed non-secret credential.
 * @param config - Validated provider and secret settings.
 * @param ownershipSignal - Aborts in-flight provider requests if the exclusive worker lock is lost.
 * @returns The configured provider adapter with timeout and ownership cancellation combined.
 */
export async function createProvider(config: Config, ownershipSignal: AbortSignal): Promise<DeepSeekNovelGenerationAdapter> {
  const key = config.provider.url === 'http://model:8081/v1'
    ? '' : await readSecret(config.secretDirectory, 'deepseek-api-key')
  return new DeepSeekNovelGenerationAdapter({
    apiKey: selectProviderKey(config.provider.url, key), baseUrl: config.provider.url, model: config.provider.model,
    timeoutMs: config.provider.timeoutMs, maxContextExcerptChars: config.provider.maxContextExcerptChars,
    fetch: (input, init) => globalThis.fetch(input, {
      ...init, signal: init?.signal === undefined || init.signal === null
        ? ownershipSignal : AbortSignal.any([init.signal, ownershipSignal]),
    }),
  })
}

/**
 * Prevent raw infrastructure or principal-resolution errors from reaching HTTP carrier logs.
 * @param controller - Assembled platform request handler.
 * @returns A handler mapping rejected requests to a fixed, redacted 503 response.
 */
export function safeController(
  controller: { handle(request: AuthHttpRequest): Promise<AuthHttpResponse> },
): { handle(request: AuthHttpRequest): Promise<AuthHttpResponse> } {
  return {
    async handle(request) {
      try { return await controller.handle(request) } catch {
        return { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"error":"service_unavailable"}' }
      }
    },
  }
}
