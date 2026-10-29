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

/** PostgreSQL schemas owned by the platform. */
export const authSchema = pgSchema('auth')
export const appSchema = pgSchema('app')
export const novelSchema = pgSchema('novel')
export const aiSchema = pgSchema('ai')
export const securitySchema = pgSchema('security')

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
}, table => ({
  userExpiryIndex: index('sessions_user_expiry_idx').on(table.userId, table.expiresAt),
}))

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
}, table => ({
  familyIndex: index('refresh_tokens_family_idx').on(table.familyId),
  userIndex: index('refresh_tokens_user_idx').on(table.userId),
}))

export const emailVerificationTokens = authSchema.table('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: instant('expires_at').notNull(),
  consumedAt: instant('consumed_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
})

export const passwordResetTokens = authSchema.table('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: instant('expires_at').notNull(),
  consumedAt: instant('consumed_at'),
  createdAt: instant('created_at').notNull().defaultNow(),
})

export const workspaces = appSchema.table('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  status: text('status').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  deletedAt: instant('deleted_at'),
}, table => ({
  ownerIndex: index('workspaces_owner_idx').on(table.ownerUserId),
}))

export const workspaceMembers = appSchema.table('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  revokedAt: instant('revoked_at'),
}, table => ({
  primaryKey: primaryKey({ columns: [table.workspaceId, table.userId] }),
  userIndex: index('workspace_members_user_idx').on(table.userId),
}))

const jsonAttributes = (name: string) => jsonb(name).$type<Record<string, unknown>>().notNull().default({})

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
}, table => ({
  workspaceIdKey: unique('novels_workspace_id_id_key').on(table.workspaceId, table.id),
}))

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
}, table => ({
  sourceIdempotencyIndex: uniqueIndex('characters_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  contextSearchIndex: index('novel_characters_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  workspaceIdKey: unique('characters_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('characters_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'characters_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'characters_workspace_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('characters_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  versionIndex: uniqueIndex('character_versions_character_no_idx').on(table.characterId, table.versionNo),
  sourceIdempotencyIndex: uniqueIndex('character_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceIndex: index('character_versions_workspace_idx').on(table.workspaceId),
  workspaceCharacterForeignKey: foreignKey({
    name: 'character_versions_workspace_novel_character_fkey',
    columns: [table.workspaceId, table.novelId, table.characterId],
    foreignColumns: [characters.workspaceId, characters.novelId, characters.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'character_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('character_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  sourceIdempotencyIndex: uniqueIndex('skills_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  contextSearchIndex: index('novel_skills_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  workspaceIdKey: unique('skills_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('skills_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'skills_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'skills_workspace_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('skills_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  versionIndex: uniqueIndex('skill_versions_skill_no_idx').on(table.skillId, table.versionNo),
  sourceIdempotencyIndex: uniqueIndex('skill_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceIndex: index('skill_versions_workspace_idx').on(table.workspaceId),
  workspaceSkillForeignKey: foreignKey({
    name: 'skill_versions_workspace_novel_skill_fkey',
    columns: [table.workspaceId, table.novelId, table.skillId],
    foreignColumns: [skills.workspaceId, skills.novelId, skills.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'skill_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('skill_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  workspaceNovelIndex: index('novel_locations_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  contextSearchIndex: index('novel_locations_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  workspaceIdKey: unique('locations_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('locations_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'locations_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'locations_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  sourceIdempotencyIndex: uniqueIndex('locations_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  statusCheck: check('locations_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  workspaceNovelIndex: index('novel_factions_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  contextSearchIndex: index('novel_factions_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  sourceIdempotencyIndex: uniqueIndex('factions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceIdKey: unique('factions_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('factions_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'factions_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'factions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('factions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  workspaceNovelIndex: index('novel_items_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  contextSearchIndex: index('novel_items_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  sourceIdempotencyIndex: uniqueIndex('items_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceIdKey: unique('items_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('items_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'items_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'items_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('items_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  workspaceNovelIndex: index('novel_storylines_workspace_novel_idx').on(table.workspaceId, table.novelId, table.status),
  contextSearchIndex: index('novel_storylines_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.name} || E'\\n' || coalesce(${table.summary}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  sourceIdempotencyIndex: uniqueIndex('storylines_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceIdKey: unique('storylines_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('storylines_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'storylines_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'storylines_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('storylines_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  versionIndex: uniqueIndex('location_versions_workspace_entity_no_idx').on(table.workspaceId, table.locationId, table.versionNo),
  sourceIdempotencyIndex: uniqueIndex('location_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  parentForeignKey: foreignKey({
    name: 'location_versions_workspace_novel_location_fkey',
    columns: [table.workspaceId, table.novelId, table.locationId],
    foreignColumns: [locations.workspaceId, locations.novelId, locations.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'location_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('location_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  versionIndex: uniqueIndex('faction_versions_workspace_entity_no_idx').on(table.workspaceId, table.factionId, table.versionNo),
  sourceIdempotencyIndex: uniqueIndex('faction_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  parentForeignKey: foreignKey({
    name: 'faction_versions_workspace_novel_faction_fkey',
    columns: [table.workspaceId, table.novelId, table.factionId],
    foreignColumns: [factions.workspaceId, factions.novelId, factions.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'faction_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('faction_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  versionIndex: uniqueIndex('item_versions_workspace_entity_no_idx').on(table.workspaceId, table.itemId, table.versionNo),
  sourceIdempotencyIndex: uniqueIndex('item_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  parentForeignKey: foreignKey({
    name: 'item_versions_workspace_novel_item_fkey',
    columns: [table.workspaceId, table.novelId, table.itemId],
    foreignColumns: [items.workspaceId, items.novelId, items.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'item_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('item_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  versionIndex: uniqueIndex('storyline_versions_workspace_entity_no_idx').on(table.workspaceId, table.storylineId, table.versionNo),
  sourceIdempotencyIndex: uniqueIndex('storyline_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  parentForeignKey: foreignKey({
    name: 'storyline_versions_workspace_novel_storyline_fkey',
    columns: [table.workspaceId, table.novelId, table.storylineId],
    foreignColumns: [storylines.workspaceId, storylines.novelId, storylines.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'storyline_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('storyline_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  versionIndex: uniqueIndex('entity_relation_versions_workspace_entity_no_idx')
    .on(table.workspaceId, table.relationId, table.versionNo),
  sourceIdempotencyIndex: uniqueIndex('entity_relation_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  parentForeignKey: foreignKey({
    name: 'entity_relation_versions_workspace_novel_relation_fkey',
    columns: [table.workspaceId, table.novelId, table.relationId],
    foreignColumns: [entityRelations.workspaceId, entityRelations.novelId, entityRelations.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'entity_relation_versions_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('entity_relation_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  primaryKey: primaryKey({ columns: [table.workspaceId, table.novelId, table.characterId, table.skillId] }),
  contextSearchIndex: index('novel_character_skills_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.relationType} || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  workspaceNovelIdKey: unique('character_skills_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  sourceIdempotencyIndex: uniqueIndex('character_skills_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceCharacterForeignKey: foreignKey({
    name: 'character_skills_workspace_character_fkey',
    columns: [table.workspaceId, table.novelId, table.characterId],
    foreignColumns: [characters.workspaceId, characters.novelId, characters.id],
  }),
  workspaceSkillForeignKey: foreignKey({
    name: 'character_skills_workspace_skill_fkey',
    columns: [table.workspaceId, table.novelId, table.skillId],
    foreignColumns: [skills.workspaceId, skills.novelId, skills.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'character_skills_workspace_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('character_skills_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  workspaceEntityVersionKey: unique('character_skill_versions_workspace_entity_version_key')
    .on(table.workspaceId, table.characterSkillId, table.versionNo),
  workspaceIndex: index('character_skill_versions_workspace_entity_idx')
    .on(table.workspaceId, table.novelId, table.characterSkillId, table.versionNo.desc()),
  sourceIdempotencyIndex: uniqueIndex('character_skill_versions_workspace_idempotency_idx')
    .on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceNovelEntityForeignKey: foreignKey({
    name: 'character_skill_versions_workspace_novel_entity_fkey',
    columns: [table.workspaceId, table.novelId, table.characterSkillId],
    foreignColumns: [characterSkills.workspaceId, characterSkills.novelId, characterSkills.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'character_skill_versions_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  versionCheck: check('character_skill_versions_version_no_check', sql`${table.versionNo} > 0`),
  statusCheck: check('character_skill_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  sourceIndex: index('entity_relations_source_idx').on(table.workspaceId, table.sourceEntityType, table.sourceEntityId),
  targetIndex: index('entity_relations_target_idx').on(table.workspaceId, table.targetEntityType, table.targetEntityId),
  contextSearchIndex: index('novel_entity_relations_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.sourceEntityType} || ':' || ${table.sourceEntityId}::text || ' ' || ${table.relationType} || ' ' || ${table.targetEntityType} || ':' || ${table.targetEntityId}::text || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  sourceIdempotencyIndex: uniqueIndex('entity_relations_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey),
  workspaceIdKey: unique('entity_relations_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('entity_relations_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'entity_relations_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'entity_relations_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  statusCheck: check('entity_relations_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
}))

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
}, table => ({
  workspaceIdKey: unique('outlines_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'outlines_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'outlines_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  sourceIdempotencyIndex: uniqueIndex('outlines_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  contextSearchIndex: index('novel_outlines_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.title} || E'\\n' || ${table.contentJsonb}::text, 16384))`),
  statusCheck: check('outlines_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  versionCheck: check('outlines_version_check', sql`${table.currentVersionNo} > 0`),
}))

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
}, table => ({
  workspaceIdKey: unique('chapters_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelNoKey: unique('chapters_workspace_novel_no_key').on(table.workspaceId, table.novelId, table.chapterNo),
  workspaceNovelIdKey: unique('chapters_workspace_novel_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'chapters_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'chapters_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  sourceIdempotencyIndex: uniqueIndex('chapters_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  contextSearchIndex: index('novel_chapters_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.title} || E'\\n' || coalesce(${table.summary}, ''), 16384))`),
  workspaceNovelStatusIndex: index('chapters_workspace_novel_status_idx').on(table.workspaceId, table.novelId, table.status, table.chapterNo),
  statusCheck: check('chapters_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  chapterNumberCheck: check('chapters_number_check', sql`${table.chapterNo} > 0`),
  versionCheck: check('chapters_version_check', sql`${table.currentVersionNo} > 0`),
}))

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
}, table => ({
  workspaceIdKey: unique('chapter_versions_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceChapterVersionKey: unique('chapter_versions_workspace_chapter_no_key').on(table.workspaceId, table.chapterId, table.versionNo),
  workspaceChapterForeignKey: foreignKey({
    name: 'chapter_versions_workspace_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.chapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'chapter_versions_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  sourceIdempotencyIndex: uniqueIndex('chapter_versions_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  contextSearchIndex: index('novel_chapter_versions_context_search_idx').using('gin', sql`to_tsvector('simple', left(coalesce(${table.summary}, '') || E'\\n' || coalesce(${table.contentText}, ${table.contentObjectKey}, ''), 16384))`),
  workspaceChapterIndex: index('chapter_versions_workspace_chapter_idx').on(table.workspaceId, table.novelId, table.chapterId, table.versionNo.desc()),
  statusCheck: check('chapter_versions_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  versionCheck: check('chapter_versions_number_check', sql`${table.versionNo} > 0`),
  bytesCheck: check('chapter_versions_bytes_check', sql`${table.contentBytes} >= 0`),
  storageKindCheck: check('chapter_versions_storage_kind_check', sql`${table.contentStorageKind} IN ('postgres_text', 'object_storage')`),
  storageCheck: check('chapter_versions_storage_check', sql`(
    (${table.contentStorageKind} = 'postgres_text' AND ${table.contentText} IS NOT NULL AND ${table.contentObjectKey} IS NULL AND ${table.contentBytes} <= 1048576)
    OR (${table.contentStorageKind} = 'object_storage' AND ${table.contentObjectKey} IS NOT NULL AND ${table.contentText} IS NULL AND ${table.contentBytes} > 1048576)
  )`),
}))

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
}, table => ({
  workspaceIdKey: unique('chapter_summaries_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceChapterForeignKey: foreignKey({
    name: 'chapter_summaries_workspace_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.chapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  workspaceVersionForeignKey: foreignKey({
    name: 'chapter_summaries_workspace_version_fkey',
    columns: [table.workspaceId, table.chapterVersionId],
    foreignColumns: [chapterVersions.workspaceId, chapterVersions.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'chapter_summaries_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  summaryKindCheck: check('chapter_summaries_kind_check', sql`${table.summaryKind} IN ('short', 'detailed', 'facts')`),
  statusCheck: check('chapter_summaries_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  uniqueKind: unique('chapter_summaries_unique_kind').on(table.workspaceId, table.chapterVersionId, table.summaryKind),
  sourceIdempotencyIndex: uniqueIndex('chapter_summaries_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  contextSearchIndex: index('novel_chapter_summaries_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.contentText}, 16384))`),
  chapterIndex: index('chapter_summaries_workspace_chapter_idx').on(table.workspaceId, table.novelId, table.chapterId, table.createdAt.desc()),
}))

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
}, table => ({
  workspaceIdKey: unique('story_facts_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'story_facts_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceChapterForeignKey: foreignKey({
    name: 'story_facts_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceChapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  sourceChapterVersionForeignKey: foreignKey({
    name: 'story_facts_chapter_version_fkey',
    columns: [table.workspaceId, table.sourceChapterVersionId],
    foreignColumns: [chapterVersions.workspaceId, chapterVersions.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'story_facts_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  sourceIdempotencyIndex: uniqueIndex('story_facts_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  contextSearchIndex: index('novel_story_facts_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.factKey} || E'\\n' || ${table.statement} || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  factKeyIndex: uniqueIndex('story_facts_workspace_key_idx').on(table.workspaceId, table.novelId, table.factKey)
    .where(sql`${table.deletedAt} IS NULL`),
  statusCheck: check('story_facts_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  versionCheck: check('story_facts_version_check', sql`${table.currentVersionNo} > 0`),
  schemaVersionCheck: check('story_facts_schema_version_check', sql`${table.attributesSchemaVersion} > 0`),
}))

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
}, table => ({
  workspaceIdKey: unique('timeline_events_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'timeline_events_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  sourceChapterForeignKey: foreignKey({
    name: 'timeline_events_chapter_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceChapterId],
    foreignColumns: [chapters.workspaceId, chapters.novelId, chapters.id],
  }),
  sourceChapterVersionForeignKey: foreignKey({
    name: 'timeline_events_chapter_version_fkey',
    columns: [table.workspaceId, table.sourceChapterVersionId],
    foreignColumns: [chapterVersions.workspaceId, chapterVersions.id],
  }),
  sourceGenerationRunForeignKey: foreignKey({
    name: 'timeline_events_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.sourceGenerationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  sourceIdempotencyIndex: uniqueIndex('timeline_events_workspace_idempotency_idx').on(table.workspaceId, table.sourceIdempotencyKey)
    .where(sql`${table.sourceIdempotencyKey} IS NOT NULL`),
  contextSearchIndex: index('novel_timeline_events_context_search_idx').using('gin', sql`to_tsvector('simple', left(${table.title} || E'\\n' || coalesce(${table.description}, '') || E'\\n' || ${table.attributesJsonb}::text, 16384))`),
  eventKeyIndex: uniqueIndex('timeline_events_workspace_key_idx').on(table.workspaceId, table.novelId, table.eventKey)
    .where(sql`${table.deletedAt} IS NULL`),
  sequenceIndex: index('timeline_events_workspace_novel_sequence_idx').on(table.workspaceId, table.novelId, table.sequenceNo, table.updatedAt.desc()),
  statusCheck: check('timeline_events_status_check', sql`${table.status} IN ('draft', 'published', 'archived', 'deleted')`),
  versionCheck: check('timeline_events_version_check', sql`${table.currentVersionNo} > 0`),
  schemaVersionCheck: check('timeline_events_schema_version_check', sql`${table.attributesSchemaVersion} > 0`),
}))

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
}, table => ({
  workspaceIdKey: unique('generation_context_items_workspace_id_id_key').on(table.workspaceId, table.id),
  generationRunForeignKey: foreignKey({
    name: 'generation_context_items_generation_run_fkey',
    columns: [table.workspaceId, table.novelId, table.generationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  runRankIndex: index('generation_context_items_run_rank_idx').on(table.workspaceId, table.novelId, table.generationRunId, table.rank),
  uniqueSource: unique('generation_context_items_unique_source').on(table.generationRunId, table.sourceType, table.sourceId),
  rankCheck: check('generation_context_items_rank_check', sql`${table.rank} >= 0`),
  tokenCountCheck: check('generation_context_items_token_count_check', sql`${table.tokenCount} >= 0`),
}))

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
}, table => ({
  workspaceIndex: index('generation_runs_workspace_idx').on(table.workspaceId, table.startedAt),
  idempotencyIndex: uniqueIndex('generation_runs_workspace_idempotency_idx').on(table.workspaceId, table.idempotencyKey),
  workspaceIdKey: unique('generation_runs_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelIdKey: unique('generation_runs_workspace_novel_id_id_key').on(table.workspaceId, table.novelId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'generation_runs_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  idempotencyKeyCheck: check('generation_runs_idempotency_key_check', sql`length(btrim(${table.idempotencyKey})) > 0`),
  statusCheck: check('generation_runs_status_check', sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`),
  completedAtCheck: check('generation_runs_completed_at_check', sql`(${table.status} IN ('completed', 'failed', 'cancelled')) = (${table.completedAt} IS NOT NULL)`),
  errorCodeCheck: check('generation_runs_error_code_length_check', sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ '^[A-Z][A-Z0-9_]{0,127}$'`),
  errorSummaryCheck: check('generation_runs_error_summary_length_check', sql`${table.errorSummary} IS NULL OR length(${table.errorSummary}) <= 512`),
  instructionLengthCheck: check('generation_runs_instruction_length_check', sql`length(${table.instruction}) <= 100000`),
  contextLimitCheck: check('generation_runs_context_limit_check', sql`${table.contextLimit} >= 0 AND ${table.contextLimit} <= 128`),
}))

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
}, table => ({
  idempotencyIndex: uniqueIndex('generation_proposals_workspace_idempotency_idx')
    .on(table.workspaceId, table.idempotencyKey),
  workspaceIndex: index('generation_proposals_workspace_status_idx').on(table.workspaceId, table.status),
  workspaceIdKey: unique('generation_proposals_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceRunForeignKey: foreignKey({
    name: 'generation_proposals_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.generationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  workspaceNovelForeignKey: foreignKey({
    name: 'generation_proposals_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  statusCheck: check('generation_proposals_status_check', sql`${table.status} IN ('draft', 'approved', 'rejected', 'published', 'expired')`),
  targetTypeCheck: check('generation_proposals_target_type_check', sql`${table.targetType} IN ('outlines', 'characters', 'skills', 'locations', 'factions', 'items', 'storylines', 'entity_relations', 'character_skills', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events')`),
  operationCheck: check('generation_proposals_operation_check', sql`${table.operation} IN ('create', 'update', 'link')`),
  characterSkillOperationCheck: check('generation_proposals_character_skill_operation_check',
    sql`${table.targetType} <> 'character_skills' OR ${table.operation} IN ('link', 'update')`),
  targetCheck: check('generation_proposals_target_check', sql`(${table.targetId} IS NOT NULL AND ((${table.operation} IN ('create', 'link') AND ${table.baseVersionNo} IS NULL) OR (${table.operation} = 'update' AND ${table.baseVersionNo} > 0))) OR (${table.status} = 'draft' AND ${table.operation} = 'create' AND ${table.targetId} IS NULL AND ${table.baseVersionNo} IS NULL)`),
}))

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
}, table => ({
  workspaceIdKey: unique('generation_results_workspace_id_id_key').on(table.workspaceId, table.id),
  workspaceNovelForeignKey: foreignKey({
    name: 'generation_results_workspace_novel_fkey',
    columns: [table.workspaceId, table.novelId],
    foreignColumns: [novels.workspaceId, novels.id],
  }),
  generationRunForeignKey: foreignKey({
    name: 'generation_results_workspace_novel_run_fkey',
    columns: [table.workspaceId, table.novelId, table.generationRunId],
    foreignColumns: [generationRuns.workspaceId, generationRuns.novelId, generationRuns.id],
  }),
  idempotencyIndex: uniqueIndex('generation_results_workspace_novel_idempotency_idx')
    .on(table.workspaceId, table.novelId, table.idempotencyKey),
}))

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
}, table => ({
  actionIndex: index('audit_events_action_idx').on(table.action, table.createdAt),
  workspaceIndex: index('audit_events_workspace_idx').on(table.workspaceId, table.createdAt),
}))

export type User = typeof users.$inferSelect
export type Session = typeof sessions.$inferSelect
export type Workspace = typeof workspaces.$inferSelect
export type WorkspaceMember = typeof workspaceMembers.$inferSelect
export type Novel = typeof novels.$inferSelect
export type Character = typeof characters.$inferSelect
export type Skill = typeof skills.$inferSelect
export type CharacterSkill = typeof characterSkills.$inferSelect
export type CharacterSkillVersion = typeof characterSkillVersions.$inferSelect
export type Outline = typeof outlines.$inferSelect
export type Chapter = typeof chapters.$inferSelect
export type ChapterVersion = typeof chapterVersions.$inferSelect
export type ChapterSummary = typeof chapterSummaries.$inferSelect
export type StoryFact = typeof storyFacts.$inferSelect
export type TimelineEvent = typeof timelineEvents.$inferSelect
export type GenerationRun = typeof generationRuns.$inferSelect
export type GenerationProposal = typeof generationProposals.$inferSelect
export type GenerationContextItem = typeof generationContextItems.$inferSelect
export type GenerationResult = typeof generationResults.$inferSelect
export type AuditEvent = typeof auditEvents.$inferSelect
