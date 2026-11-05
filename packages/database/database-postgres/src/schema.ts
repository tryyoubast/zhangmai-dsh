/** Typed Drizzle mappings for platform tables; versioned SQL migrations own RLS and database procedures. */
import {
  check,
  boolean,
  bigint,
  integer,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
  unique,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** Authentication schema containing users and hashed credential material. */
export const authSchema = pgSchema('auth')
/** Workspace ownership and membership schema used by tenant access policies. */
export const appSchema = pgSchema('app')
/** Novel content schema containing draft entities, chapter bodies, and version history. */
export const novelSchema = pgSchema('novel')
/** Generation schema containing durable requests, replay context, results, and review proposals. */
export const aiSchema = pgSchema('ai')
/** Security schema containing attributed audit records. */
export const securitySchema = pgSchema('security')

/** Account records with normalized-email uniqueness, password hashes, and login lock state. */
export const users = authSchema.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  status: text('status').notNull(),
  emailVerifiedAt: instant('email_verified_at'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: instant('locked_until'),
  passwordChangedAt: instant('password_changed_at').notNull(),
  lastLoginAt: instant('last_login_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
})

/** Hashed browser or official-client session credentials with expiry and revocation metadata. */
export const sessions = authSchema.table('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  clientType: text('client_type').notNull(),
  userAgent: text('user_agent'),
  ipHash: text('ip_hash'),
  expiresAt: instant('expires_at').notNull(),
  lastSeenAt: instant('last_seen_at').notNull(),
  revokedAt: instant('revoked_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  index('sessions_user_expiry_idx').on(table.userId, table.expiresAt),
])

/** Hashed refresh-token families with consumed, revoked, and replacement-token metadata. */
export const refreshTokens = authSchema.table('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  familyId: uuid('family_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: instant('expires_at').notNull(),
  usedAt: instant('used_at'),
  revokedAt: instant('revoked_at'),
  replacedBy: uuid('replaced_by'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  index('refresh_tokens_family_idx').on(table.familyId),
  index('refresh_tokens_user_idx').on(table.userId),
])

/** Hashed one-time email verification tokens with expiry and consumption timestamps. */
export const emailVerificationTokens = authSchema.table('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: instant('expires_at').notNull(),
  consumedAt: instant('consumed_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
})

/** Hashed one-time password reset tokens with expiry and consumption timestamps. */
export const passwordResetTokens = authSchema.table('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: instant('expires_at').notNull(),
  consumedAt: instant('consumed_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
})

/** Tenant records with an owning user and lifecycle status; membership is stored separately. */
export const workspaces = appSchema.table('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  status: text('status').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  index('workspaces_owner_idx').on(table.ownerUserId),
])

/** Workspace roles keyed by workspace and user; revocation retains the membership row. */
export const workspaceMembers = appSchema.table('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  revokedAt: instant('revoked_at'),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index('workspace_members_user_idx').on(table.userId),
])

const jsonAttributes = (name: string) => jsonb(name).$type<Record<string, unknown>>().notNull().default({})

/** Workspace-owned novel metadata with versioned JSON attributes and creator attribution. */
export const novels = novelSchema.table('novels', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  title: text('title').notNull(),
  status: text('status').notNull(),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  unique('novels_workspace_id_id_key').on(table.workspaceId, table.id),
])

/** Novel character drafts and published state with generation provenance and retry keys. */
export const characters = novelSchema.table('characters', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull().references(() => novels.id),
  name: text('name').notNull(),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  uniqueIndex('characters_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  index('novel_characters_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  unique('characters_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('characters_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'characters_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'characters_workspace_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('characters_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Character content snapshots keyed by character and version number. */
export const characterVersions = novelSchema.table('character_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  characterId: uuid('character_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('character_versions_character_no_idx').on(table.characterId, table.versionNo),
  uniqueIndex('character_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  index('character_versions_workspace_idx').on(table.workspaceId),
  foreignKey({
    name: 'character_versions_workspace_novel_character_fkey',
    columns: [table.workspaceId, table.novelId, table.characterId],
    foreignColumns: [characters.workspaceId, characters.novelId, characters.id],
  }),
  foreignKey({
    name: 'character_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('character_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Novel skill records with lifecycle state, current version, and generation provenance. */
export const skills = novelSchema.table('skills', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull().references(() => novels.id),
  name: text('name').notNull(),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  uniqueIndex('skills_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  index('novel_skills_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  unique('skills_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('skills_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'skills_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'skills_workspace_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('skills_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Skill content snapshots keyed by skill and version number. */
export const skillVersions = novelSchema.table('skill_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('skill_versions_skill_no_idx').on(table.skillId, table.versionNo),
  uniqueIndex('skill_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  index('skill_versions_workspace_idx').on(table.workspaceId),
  foreignKey({
    name: 'skill_versions_workspace_novel_skill_fkey',
    columns: [table.workspaceId, table.novelId, table.skillId],
    foreignColumns: [skills.workspaceId, skills.novelId, skills.id],
  }),
  foreignKey({
    name: 'skill_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('skill_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Novel location records with lifecycle state and workspace-scoped generation retry keys. */
export const locations = novelSchema.table('locations', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull().references(() => novels.id),
  name: text('name').notNull(),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  index('novel_locations_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  index('novel_locations_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  unique('locations_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('locations_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'locations_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'locations_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  uniqueIndex('locations_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  check('locations_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Novel faction records with lifecycle state and workspace-scoped generation retry keys. */
export const factions = novelSchema.table('factions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull().references(() => novels.id),
  name: text('name').notNull(),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  index('novel_factions_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  index('novel_factions_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  uniqueIndex('factions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  unique('factions_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('factions_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'factions_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'factions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('factions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Novel item records with lifecycle state and workspace-scoped generation retry keys. */
export const items = novelSchema.table('items', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull().references(() => novels.id),
  name: text('name').notNull(),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  index('novel_items_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  index('novel_items_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  uniqueIndex('items_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  unique('items_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('items_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'items_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'items_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('items_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Novel storyline records with lifecycle state and workspace-scoped generation retry keys. */
export const storylines = novelSchema.table('storylines', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull().references(() => novels.id),
  name: text('name').notNull(),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  index('novel_storylines_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  index('novel_storylines_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  uniqueIndex('storylines_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  unique('storylines_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('storylines_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'storylines_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'storylines_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('storylines_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Location content snapshots tied to the same workspace, novel, and source generation run. */
export const locationVersions = novelSchema.table('location_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  locationId: uuid('location_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('location_versions_workspace_entity_no_idx').on(table.workspaceId, table.locationId, table.versionNo),
  uniqueIndex('location_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  foreignKey({
    name: 'location_versions_workspace_novel_location_fkey',
    columns: [table.workspaceId, table.novelId, table.locationId],
    foreignColumns: [locations.workspaceId, locations.novelId, locations.id],
  }),
  foreignKey({
    name: 'location_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('location_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Faction content snapshots tied to the same workspace, novel, and source generation run. */
export const factionVersions = novelSchema.table('faction_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  factionId: uuid('faction_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('faction_versions_workspace_entity_no_idx').on(table.workspaceId, table.factionId, table.versionNo),
  uniqueIndex('faction_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  foreignKey({
    name: 'faction_versions_workspace_novel_faction_fkey',
    columns: [table.workspaceId, table.novelId, table.factionId],
    foreignColumns: [factions.workspaceId, factions.novelId, factions.id],
  }),
  foreignKey({
    name: 'faction_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('faction_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Item content snapshots tied to the same workspace, novel, and source generation run. */
export const itemVersions = novelSchema.table('item_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  itemId: uuid('item_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('item_versions_workspace_entity_no_idx').on(table.workspaceId, table.itemId, table.versionNo),
  uniqueIndex('item_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  foreignKey({
    name: 'item_versions_workspace_novel_item_fkey',
    columns: [table.workspaceId, table.novelId, table.itemId],
    foreignColumns: [items.workspaceId, items.novelId, items.id],
  }),
  foreignKey({
    name: 'item_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('item_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Storyline content snapshots tied to the same workspace, novel, and source generation run. */
export const storylineVersions = novelSchema.table('storyline_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  storylineId: uuid('storyline_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('storyline_versions_workspace_entity_no_idx').on(table.workspaceId, table.storylineId, table.versionNo),
  uniqueIndex('storyline_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  foreignKey({
    name: 'storyline_versions_workspace_novel_storyline_fkey',
    columns: [table.workspaceId, table.novelId, table.storylineId],
    foreignColumns: [storylines.workspaceId, storylines.novelId, storylines.id],
  }),
  foreignKey({
    name: 'storyline_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('storyline_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Entity-relation content snapshots keyed by workspace, relation, and version number. */
export const entityRelationVersions = novelSchema.table('entity_relation_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  relationId: uuid('relation_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('entity_relation_versions_workspace_entity_no_idx')
    .on(table.workspaceId, table.relationId, table.versionNo),
  uniqueIndex('entity_relation_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  foreignKey({
    name: 'entity_relation_versions_workspace_novel_relation_fkey',
    columns: [table.workspaceId, table.novelId, table.relationId],
    foreignColumns: [entityRelations.workspaceId, entityRelations.novelId, entityRelations.id],
  }),
  foreignKey({
    name: 'entity_relation_versions_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('entity_relation_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Character-to-skill links with relation metadata and generation provenance in one novel. */
export const characterSkills = novelSchema.table('character_skills', {
  id: uuid('id').notNull().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  characterId: uuid('character_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  relationType: text('relation_type').notNull(),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  sourceVersionNo: integer('source_version_no'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.novelId, table.characterId, table.skillId] }),
  index('novel_character_skills_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.relationType} || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  unique('character_skills_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  uniqueIndex('character_skills_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  foreignKey({
    name: 'character_skills_workspace_character_fkey',
    columns: [table.workspaceId, table.novelId, table.characterId],
    foreignColumns: [characters.workspaceId, characters.novelId, characters.id],
  }),
  foreignKey({
    name: 'character_skills_workspace_skill_fkey',
    columns: [table.workspaceId, table.novelId, table.skillId],
    foreignColumns: [skills.workspaceId, skills.novelId, skills.id],
  }),
  foreignKey({
    name: 'character_skills_workspace_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('character_skills_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Character-to-skill link snapshots keyed by link and version number. */
export const characterSkillVersions = novelSchema.table('character_skill_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  novelId: uuid('novel_id').notNull(),
  characterSkillId: uuid('character_skill_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  unique('character_skill_versions_workspace_entity_version_key')
    .on(table.workspaceId, table.characterSkillId, table.versionNo),
  index('character_skill_versions_workspace_entity_idx')
    .on(table.workspaceId, table.novelId, table.characterSkillId, table.versionNo.desc()),
  uniqueIndex('character_skill_versions_workspace_idempotency_idx')
    .on(table.workspaceId, table.sourceIdempotencyKey),
  foreignKey({
    name: 'character_skill_versions_workspace_novel_entity_fkey',
    columns: [table.workspaceId, table.novelId, table.characterSkillId],
    foreignColumns: [characterSkills.workspaceId, characterSkills.novelId, characterSkills.id],
  }),
  foreignKey({
    name: 'character_skill_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('character_skill_versions_version_no_check', sql`${table.versionNo} > 0`),
  check('character_skill_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Typed relationships between novel entities with lifecycle, strength, and provenance metadata. */
export const entityRelations = novelSchema.table('entity_relations', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  sourceEntityType: text('source_entity_type').notNull(),
  sourceEntityId: uuid('source_entity_id').notNull(),
  targetEntityType: text('target_entity_type').notNull(),
  targetEntityId: uuid('target_entity_id').notNull(),
  relationType: text('relation_type').notNull(),
  status: text('status').notNull().default('draft'),
  strength: integer('strength'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  sourceVersionNo: integer('source_version_no'),
  validFrom: instant('valid_from'),
  validTo: instant('valid_to'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  index('entity_relations_source_idx').on(table.workspaceId, table.sourceEntityType, table.sourceEntityId),
  index('entity_relations_target_idx').on(table.workspaceId, table.targetEntityType, table.targetEntityId),
  index('novel_entity_relations_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.sourceEntityType} || ':' || ${table.sourceEntityId}::text || ' ' || ${table.relationType} || ' ' || ${table.targetEntityType} || ':' || ${table.targetEntityId}::text || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  uniqueIndex('entity_relations_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  unique('entity_relations_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('entity_relations_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'entity_relations_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'entity_relations_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('entity_relations_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
])

/** Structured novel outlines with reviewable lifecycle state and current version numbers. */
export const outlines = novelSchema.table('outlines', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  title: text('title').notNull(),
  contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('draft'),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  unique('outlines_workspace_id_id_key').on(table.workspaceId, table.id),
  foreignKey({
    name: 'outlines_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'outlines_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  uniqueIndex('outlines_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  index('novel_outlines_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.title} || E'\\n' || ${table.contentJsonb}::text, 16384))`),
  check('outlines_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  check('outlines_version_check', sql`${table.currentVersionNo} > 0`),
])

/** Chapter metadata with novel-scoped chapter numbers; chapter bodies live in version records. */
export const chapters = novelSchema.table('chapters', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  chapterNo: integer('chapter_no').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  unique('chapters_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('chapters_workspace_novel_no_key').on(table.workspaceId, table.novelId, table.chapterNo),
  unique('chapters_workspace_novel_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'chapters_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'chapters_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  uniqueIndex('chapters_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  index('novel_chapters_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.title} || E'\\n' || coalesce(${table.summary}, ''), 16384))`),
  index('chapters_workspace_novel_status_idx').on(table.workspaceId, table.novelId, table.status, table.chapterNo),
  check('chapters_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  check('chapters_number_check', sql`${table.chapterNo} > 0`),
  check('chapters_version_check', sql`${table.currentVersionNo} > 0`),
])

/** Chapter body versions stored inline up to 1 MiB or by object key above that limit. */
export const chapterVersions = novelSchema.table('chapter_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  chapterId: uuid('chapter_id').notNull(),
  versionNo: integer('version_no').notNull(),
  status: text('status').notNull().default('draft'),
  contentSha256: text('content_sha256').notNull(),
  contentBytes: bigint('content_bytes', { mode: 'number' }).notNull(),
  contentStorageKind: text('content_storage_kind').notNull(),
  contentText: text('content_text'),
  contentObjectKey: text('content_object_key'),
  summary: text('summary'),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  unique('chapter_versions_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('chapter_versions_workspace_chapter_no_key').on(table.workspaceId, table.chapterId, table.versionNo),
  foreignKey({
    name: 'chapter_versions_workspace_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.chapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  foreignKey({
    name: 'chapter_versions_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  uniqueIndex('chapter_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  index('novel_chapter_versions_context_search_idx').using('gin', sql`to_tsvector('simple', left(coalesce(${table.summary}, '') || E'\\n' || coalesce(${table.contentText}, ${table.contentObjectKey}, ''), 16384))`),
  index('chapter_versions_workspace_chapter_idx').on(table.workspaceId, table.novelId, table.chapterId, table.versionNo.desc()),
  check('chapter_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  check('chapter_versions_number_check', sql`${table.versionNo} > 0`),
  check('chapter_versions_bytes_check', sql`${table.contentBytes} >= 0`),
  check('chapter_versions_storage_kind_check', sql`${table.contentStorageKind} IN ('postgres_text', 'object_storage')`),
  check('chapter_versions_storage_check', sql`(
    (${table.contentStorageKind} = 'postgres_text' AND ${table.contentText} IS NOT NULL AND ${table.contentObjectKey} IS NULL AND ${table.contentBytes} <= 1048576)
    OR (${table.contentStorageKind} = 'object_storage' AND ${table.contentObjectKey} IS NOT NULL AND ${table.contentText} IS NULL AND ${table.contentBytes} > 1048576)
  )`),
])

/** Chapter-version summaries with content digests and one row per summary kind. */
export const chapterSummaries = novelSchema.table('chapter_summaries', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  chapterId: uuid('chapter_id').notNull(),
  chapterVersionId: uuid('chapter_version_id').notNull(),
  summaryKind: text('summary_kind').notNull(),
  contentText: text('content_text').notNull(),
  contentSha256: text('content_sha256').notNull(),
  status: text('status').notNull().default('draft'),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  unique('chapter_summaries_workspace_id_id_key').on(table.workspaceId, table.id),
  foreignKey({
    name: 'chapter_summaries_workspace_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.chapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  foreignKey({
    name: 'chapter_summaries_workspace_version_fkey',
    columns: [table.workspaceId, table.chapterVersionId],
    foreignColumns: [chapterVersions.workspaceId, chapterVersions.id],
  }),
  foreignKey({
    name: 'chapter_summaries_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  check('chapter_summaries_kind_check', sql`${table.summaryKind} IN ('short', 'detailed', 'facts')`),
  check('chapter_summaries_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  unique('chapter_summaries_unique_kind').on(table.workspaceId, table.chapterVersionId, table.summaryKind),
  uniqueIndex('chapter_summaries_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  index('novel_chapter_summaries_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.contentText}, 16384))`),
  index('chapter_summaries_workspace_chapter_idx').on(table.workspaceId, table.novelId, table.chapterId, table.createdAt.desc()),
])

/** Novel facts with fact-key uniqueness among rows without a deletion timestamp and optional chapter sources. */
export const storyFacts = novelSchema.table('story_facts', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  factKey: text('fact_key').notNull(),
  statement: text('statement').notNull(),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  sourceChapterId: uuid('source_chapter_id'),
  sourceChapterVersionId: uuid('source_chapter_version_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  unique('story_facts_workspace_id_id_key').on(table.workspaceId, table.id),
  foreignKey({
    name: 'story_facts_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'story_facts_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceChapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  foreignKey({
    name: 'story_facts_chapter_version_fkey',
    columns: [table.workspaceId, table.sourceChapterVersionId],
    foreignColumns: [chapterVersions.workspaceId, chapterVersions.id],
  }),
  foreignKey({
    name: 'story_facts_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  uniqueIndex('story_facts_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  index('novel_story_facts_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.factKey} || E'\\n' || ${table.statement} || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  uniqueIndex('story_facts_workspace_key_idx').on(table.workspaceId, table.novelId, table.factKey)
    .where(sql`${table.deletedAt} IS NULL`),
  check('story_facts_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  check('story_facts_version_check', sql`${table.currentVersionNo} > 0`),
  check('story_facts_schema_version_check', sql`${table.attributesSchemaVersion} > 0`),
])

/** Novel timeline events with event-key uniqueness among rows without a deletion timestamp and optional chapter provenance. */
export const timelineEvents = novelSchema.table('timeline_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  eventKey: text('event_key').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  sequenceNo: integer('sequence_no'),
  status: text('status').notNull().default('draft'),
  attributesJsonb: jsonAttributes('attributes_jsonb'),
  attributesSchemaVersion: integer('attributes_schema_version').notNull().default(1),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  sourceChapterId: uuid('source_chapter_id'),
  sourceChapterVersionId: uuid('source_chapter_version_id'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  sourceGenerationRunId: uuid('source_generation_run_id'),
  sourceIdempotencyKey: text('source_idempotency_key'),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => [
  unique('timeline_events_workspace_id_id_key').on(table.workspaceId, table.id),
  foreignKey({
    name: 'timeline_events_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'timeline_events_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceChapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  foreignKey({
    name: 'timeline_events_chapter_version_fkey',
    columns: [table.workspaceId, table.sourceChapterVersionId],
    foreignColumns: [chapterVersions.workspaceId, chapterVersions.id],
  }),
  foreignKey({
    name: 'timeline_events_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  uniqueIndex('timeline_events_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  index('novel_timeline_events_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.title} || E'\\n' || coalesce(${table.description}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  uniqueIndex('timeline_events_workspace_key_idx').on(table.workspaceId, table.novelId, table.eventKey)
    .where(sql`${table.deletedAt} IS NULL`),
  index('timeline_events_workspace_novel_sequence_idx').on(table.workspaceId, table.novelId, table.sequenceNo, table.updatedAt.desc()),
  check('timeline_events_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  check('timeline_events_version_check', sql`${table.currentVersionNo} > 0`),
  check('timeline_events_schema_version_check', sql`${table.attributesSchemaVersion} > 0`),
])

/** Ranked generation context snapshots; nullable excerpts identify legacy selections needing a rerun. */
export const generationContextItems = aiSchema.table('generation_context_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  generationRunId: uuid('generation_run_id').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  rank: integer('rank').notNull(),
  excerptHash: text('excerpt_hash').notNull(),
  excerpt: text('excerpt'),
  sourceStatus: text('source_status'),
  requiresRerun: boolean('requires_rerun').notNull().default(false),
  tokenCount: integer('token_count').notNull(),
  selectionReason: text('selection_reason').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  unique('generation_context_items_workspace_id_id_key').on(table.workspaceId, table.id),
  foreignKey({
    name: 'generation_context_items_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.generationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  index('generation_context_items_run_rank_idx').on(table.workspaceId, table.novelId, table.generationRunId, table.rank),
  unique('generation_context_items_unique_source').on(table.generationRunId, table.sourceType, table.sourceId),
  check('generation_context_items_rank_check', sql`${table.rank} >= 0`),
  check('generation_context_items_token_count_check', sql`${table.tokenCount} >= 0`),
])

/** Workspace-scoped idempotent generation requests with worker identity, heartbeat, and terminal status. */
export const generationRuns = aiSchema.table('generation_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  initiatedByUserId: uuid('initiated_by_user_id').notNull().references(() => users.id),
  agentPrincipalId: text('agent_principal_id').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  sourceSessionId: uuid('source_session_id'),
  instruction: text('instruction').notNull().default(''),
  contextLimit: integer('context_limit').notNull().default(8),
  heartbeatAt: instant('heartbeat_at'),
  errorSummary: text('error_summary'),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status').notNull(),
  startedAt: instant('started_at').notNull().defaultNow(),
  completedAt: instant('completed_at'),
  errorCode: text('error_code'),
}, table => [
  index('generation_runs_workspace_idx').on(table.workspaceId, table.startedAt),
  uniqueIndex('generation_runs_workspace_idempotency_idx').on(table.workspaceId, table.idempotencyKey),
  unique('generation_runs_workspace_id_id_key').on(table.workspaceId, table.id),
  unique('generation_runs_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  foreignKey({
    name: 'generation_runs_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  check('generation_runs_idempotency_key_check', sql`length(btrim(${table.idempotencyKey})) > 0`),
  check('generation_runs_status_check', sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`),
  check('generation_runs_completed_at_check', sql`(${table.status} IN ('completed', 'failed', 'cancelled')) = (${table.completedAt} IS NOT NULL)`),
  check('generation_runs_error_code_length_check', sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ '^[A-Z][A-Z0-9_]{0,127}$'`),
  check('generation_runs_error_summary_length_check', sql`${table.errorSummary} IS NULL OR length(${table.errorSummary}) <= 512`),
  check('generation_runs_instruction_length_check', sql`length(${table.instruction}) <= 100000`),
  check('generation_runs_context_limit_check', sql`${table.contextLimit} >= 0 AND ${table.contextLimit} <= 128`),
])

/** Reviewable generated edits with target identity, optional base version, and reviewer attribution. */
export const generationProposals = aiSchema.table('generation_proposals', {
  id: uuid('id').defaultRandom().primaryKey(),
  generationRunId: uuid('generation_run_id').notNull(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  operation: text('operation').notNull(),
  baseVersionNo: integer('base_version_no'),
  proposedContent: jsonb('proposed_content').$type<Record<string, unknown>>().notNull(),
  validationResult: jsonb('validation_result').$type<Record<string, unknown>>().notNull(),
  conflictResult: jsonb('conflict_result').$type<Record<string, unknown>>(),
  status: text('status').notNull(),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id),
  reviewedAt: instant('reviewed_at'),
  publishedAt: instant('published_at'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  uniqueIndex('generation_proposals_workspace_idempotency_idx')
    .on(table.workspaceId, table.idempotencyKey),
  index('generation_proposals_workspace_status_idx').on(table.workspaceId, table.status),
  unique('generation_proposals_workspace_id_id_key').on(table.workspaceId, table.id),
  foreignKey({
    name: 'generation_proposals_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.generationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  foreignKey({
    name: 'generation_proposals_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  check('generation_proposals_status_check', sql`${table.status} IN ('draft', 'approved', 'rejected', 'published', 'expired')`),
  check('generation_proposals_target_type_check', sql`${table.targetType} IN ('outlines', 'characters', 'skills', 'locations', 'factions', 'items', 'storylines', 'entity_relations', 'character_skills', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events')`),
  check('generation_proposals_operation_check', sql`${table.operation} IN ('create', 'update', 'link')`),
  check('generation_proposals_character_skill_operation_check',
    sql`${table.targetType} <> 'character_skills' OR ${table.operation} IN ('link', 'update')`),
  check('generation_proposals_target_check', sql`(${table.targetId} IS NOT NULL AND ((${table.operation} IN ('create', 'link') AND ${table.baseVersionNo} IS NULL) OR (${table.operation} = 'update' AND ${table.baseVersionNo} > 0))) OR (${table.status} = 'draft' AND ${table.operation} = 'create' AND ${table.targetId} IS NULL AND ${table.baseVersionNo} IS NULL)`),
])

/** Durable structured generation output used to make retries atomic and replayable. */
export const generationResults = aiSchema.table('generation_results', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  novelId: uuid('novel_id').notNull(),
  generationRunId: uuid('generation_run_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  selectedContext: jsonb('selected_context').$type<readonly Record<string, unknown>[]>().notNull().default([]),
  records: jsonb('records').$type<readonly Record<string, unknown>[]>().notNull().default([]),
  proposals: jsonb('proposals').$type<readonly Record<string, unknown>[]>().notNull().default([]),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  unique('generation_results_workspace_id_id_key').on(table.workspaceId, table.id),
  foreignKey({
    name: 'generation_results_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  foreignKey({
    name: 'generation_results_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.generationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  uniqueIndex('generation_results_workspace_novel_idempotency_idx')
    .on(table.workspaceId, table.novelId, table.idempotencyKey),
])

/** Attributed security actions with optional workspace scope and structured metadata. */
export const auditEvents = securitySchema.table('audit_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: instant('created_at').notNull().defaultNow(),
}, table => [
  index('audit_events_action_idx').on(table.action, table.createdAt),
  index('audit_events_workspace_idx').on(table.workspaceId, table.createdAt),
])

/** Selected account row including the password hash and account lock state; keep it server-side. */
export type User = typeof users.$inferSelect
/** Selected session row containing a token hash and expiry and revocation metadata. */
export type Session = typeof sessions.$inferSelect
/** Selected tenant row with its owner and lifecycle state. */
export type Workspace = typeof workspaces.$inferSelect
/** Selected workspace membership row, including revoked memberships when queried. */
export type WorkspaceMember = typeof workspaceMembers.$inferSelect
/** Selected workspace-owned novel row with JSON attributes and creator attribution. */
export type Novel = typeof novels.$inferSelect
/** Selected character row with current version and generation provenance. */
export type Character = typeof characters.$inferSelect
/** Selected skill row with current version and generation provenance. */
export type Skill = typeof skills.$inferSelect
/** Selected character-to-skill link row with lifecycle state and relation attributes. */
export type CharacterSkill = typeof characterSkills.$inferSelect
/** Selected historical character-to-skill link row with its content snapshot. */
export type CharacterSkillVersion = typeof characterSkillVersions.$inferSelect
/** Selected outline row with structured content and current version metadata. */
export type Outline = typeof outlines.$inferSelect
/** Selected chapter metadata row; its body is resolved through chapter versions. */
export type Chapter = typeof chapters.$inferSelect
/** Selected chapter body version with either inline text or an object-storage key. */
export type ChapterVersion = typeof chapterVersions.$inferSelect
/** Selected summary row identifying its chapter version, kind, and content digest. */
export type ChapterSummary = typeof chapterSummaries.$inferSelect
/** Selected fact row with its fact key and optional chapter provenance. */
export type StoryFact = typeof storyFacts.$inferSelect
/** Selected timeline event row with sequence and optional chapter provenance. */
export type TimelineEvent = typeof timelineEvents.$inferSelect
/** Selected generation request row with worker attribution and lifecycle diagnostics. */
export type GenerationRun = typeof generationRuns.$inferSelect
/** Selected proposal row containing generated content, review status, and publication metadata. */
export type GenerationProposal = typeof generationProposals.$inferSelect
/** Selected context row; legacy excerpt and source-status fields may be null. */
export type GenerationContextItem = typeof generationContextItems.$inferSelect
/** Selected durable generation output row used to replay an idempotent request. */
export type GenerationResult = typeof generationResults.$inferSelect
/** Selected attributed security event row with structured action metadata. */
export type AuditEvent = typeof auditEvents.$inferSelect
