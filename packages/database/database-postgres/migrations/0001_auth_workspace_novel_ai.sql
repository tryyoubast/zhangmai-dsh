BEGIN;

-- UUID defaults use PostgreSQL's trusted pgcrypto implementation.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS novel;
CREATE SCHEMA IF NOT EXISTS ai;
CREATE SCHEMA IF NOT EXISTS security;

-- Roles are group roles. Deployment supplies login principals and credentials.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_migrator') THEN
    CREATE ROLE dsh_migrator NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_auth_runtime') THEN
    CREATE ROLE dsh_auth_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_app_runtime') THEN
    CREATE ROLE dsh_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_worker_runtime') THEN
    CREATE ROLE dsh_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_readonly') THEN
    CREATE ROLE dsh_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_service_runtime') THEN
    CREATE ROLE dsh_service_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- dsh_migrator is deployment-only and needs CREATEROLE for this bootstrap.
ALTER ROLE dsh_migrator NOSUPERUSER NOCREATEDB CREATEROLE NOBYPASSRLS;
ALTER ROLE dsh_auth_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE dsh_app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE dsh_worker_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE dsh_readonly NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE dsh_service_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

REVOKE CREATE ON SCHEMA auth FROM PUBLIC;
REVOKE CREATE ON SCHEMA app FROM PUBLIC;
REVOKE CREATE ON SCHEMA novel FROM PUBLIC;
REVOKE CREATE ON SCHEMA ai FROM PUBLIC;
REVOKE CREATE ON SCHEMA security FROM PUBLIC;

GRANT USAGE, CREATE ON SCHEMA auth, app, novel, ai, security TO dsh_migrator;
GRANT USAGE ON SCHEMA auth, app, novel, ai, security
  TO dsh_auth_runtime, dsh_app_runtime, dsh_worker_runtime, dsh_readonly, dsh_service_runtime;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  configured_id text := current_setting('app.user_id', true);
BEGIN
  IF configured_id IS NULL OR configured_id = '' THEN
    RETURN NULL;
  END IF;
  RETURN configured_id::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app.current_service_bypass()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_user = 'dsh_service_runtime'
    AND COALESCE(NULLIF(current_setting('app.service_bypass', true), '')::boolean, false)
$$;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'disabled', 'deleted')),
  email_verified_at TIMESTAMPTZ,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  token_hash TEXT NOT NULL UNIQUE,
  client_type TEXT NOT NULL CHECK (client_type IN ('web', 'official_client')),
  user_agent TEXT,
  ip_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_expiry_idx ON auth.sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  session_id UUID NOT NULL REFERENCES auth.sessions(id),
  family_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES auth.refresh_tokens(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_family_idx ON auth.refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user_idx ON auth.refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS auth.email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS app_workspaces_owner_idx ON app.workspaces(owner_user_id);

CREATE TABLE IF NOT EXISTS app.workspace_members (
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS app_workspace_members_user_idx ON app.workspace_members(user_id);

CREATE OR REPLACE FUNCTION app.workspace_access_allowed(
  requested_workspace_id UUID,
  minimum_role TEXT DEFAULT 'member'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.workspace_members AS member
    WHERE member.workspace_id = requested_workspace_id
      AND member.user_id = app.current_user_id()
      AND member.revoked_at IS NULL
      AND CASE minimum_role
        WHEN 'member' THEN member.role IN ('member', 'editor', 'admin', 'owner')
        WHEN 'editor' THEN member.role IN ('editor', 'admin', 'owner')
        WHEN 'admin' THEN member.role IN ('admin', 'owner')
        WHEN 'owner' THEN member.role = 'owner'
        ELSE false
      END
  )
$$;

CREATE OR REPLACE FUNCTION app.workspace_owner_is_current_user(requested_workspace_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.workspaces AS workspace
    WHERE workspace.id = requested_workspace_id
      AND workspace.owner_user_id = app.current_user_id()
  )
$$;

CREATE TABLE IF NOT EXISTS novel.novels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived', 'deleted')),
  attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (attributes_schema_version > 0),
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS novel_novels_workspace_idx ON novel.novels(workspace_id);

CREATE TABLE IF NOT EXISTS novel.characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  novel_id UUID NOT NULL REFERENCES novel.novels(id),
  name TEXT NOT NULL,
  summary TEXT,
  attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (attributes_schema_version > 0),
  current_version_no INTEGER NOT NULL DEFAULT 1 CHECK (current_version_no > 0),
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS novel_characters_workspace_novel_idx ON novel.characters(workspace_id, novel_id);

CREATE TABLE IF NOT EXISTS novel.character_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  character_id UUID NOT NULL REFERENCES novel.characters(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  content_jsonb JSONB NOT NULL,
  source_type TEXT NOT NULL,
  source_id UUID,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, version_no)
);
CREATE INDEX IF NOT EXISTS novel_character_versions_workspace_idx ON novel.character_versions(workspace_id);

CREATE TABLE IF NOT EXISTS novel.skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  novel_id UUID NOT NULL REFERENCES novel.novels(id),
  name TEXT NOT NULL,
  summary TEXT,
  attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (attributes_schema_version > 0),
  current_version_no INTEGER NOT NULL DEFAULT 1 CHECK (current_version_no > 0),
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS novel_skills_workspace_novel_idx ON novel.skills(workspace_id, novel_id);

CREATE TABLE IF NOT EXISTS novel.skill_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  skill_id UUID NOT NULL REFERENCES novel.skills(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  content_jsonb JSONB NOT NULL,
  source_type TEXT NOT NULL,
  source_id UUID,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version_no)
);
CREATE INDEX IF NOT EXISTS novel_skill_versions_workspace_idx ON novel.skill_versions(workspace_id);

CREATE TABLE IF NOT EXISTS novel.character_skills (
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  character_id UUID NOT NULL REFERENCES novel.characters(id),
  skill_id UUID NOT NULL REFERENCES novel.skills(id),
  relation_type TEXT NOT NULL,
  source_version_no INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, skill_id)
);
CREATE INDEX IF NOT EXISTS novel_character_skills_workspace_idx ON novel.character_skills(workspace_id);

CREATE TABLE IF NOT EXISTS novel.entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  source_entity_type TEXT NOT NULL,
  source_entity_id UUID NOT NULL,
  target_entity_type TEXT NOT NULL,
  target_entity_id UUID NOT NULL,
  relation_type TEXT NOT NULL,
  strength INTEGER,
  source_version_no INTEGER,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS novel_entity_relations_source_idx
  ON novel.entity_relations(workspace_id, source_entity_type, source_entity_id);
CREATE INDEX IF NOT EXISTS novel_entity_relations_target_idx
  ON novel.entity_relations(workspace_id, target_entity_type, target_entity_id);

CREATE TABLE IF NOT EXISTS ai.generation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  initiated_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  agent_principal_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  source_session_id UUID,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS ai_generation_runs_workspace_idx
  ON ai.generation_runs(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai.generation_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id UUID NOT NULL REFERENCES ai.generation_runs(id),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id),
  target_type TEXT NOT NULL,
  target_id UUID,
  operation TEXT NOT NULL,
  base_version_no INTEGER,
  proposed_content JSONB NOT NULL,
  validation_result JSONB NOT NULL,
  conflict_result JSONB,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'published', 'expired')),
  reviewed_by_user_id UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (status <> 'published' OR (reviewed_by_user_id IS NOT NULL AND published_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ai_generation_proposals_workspace_status_idx
  ON ai.generation_proposals(workspace_id, status);

CREATE TABLE IF NOT EXISTS security.audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES app.workspaces(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_audit_events_action_idx ON security.audit_events(action, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_events_workspace_idx
  ON security.audit_events(workspace_id, created_at DESC);

CREATE OR REPLACE FUNCTION security.prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security.audit_events is append-only';
  RETURN NULL;
END
$$;
CREATE OR REPLACE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON security.audit_events
  FOR EACH ROW EXECUTE FUNCTION security.prevent_audit_mutation();

-- All tenant tables use the same transaction-local identity context. Tables
-- remain owned by the migration role so the SECURITY DEFINER membership check
-- can read workspace_members; runtime roles are explicitly NOBYPASSRLS.
ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.novels ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.character_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.character_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.entity_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.generation_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspaces_member_access ON app.workspaces
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(id, 'member'));
CREATE POLICY workspaces_owner_create ON app.workspaces
  FOR INSERT TO dsh_app_runtime
  WITH CHECK (owner_user_id = app.current_user_id());
CREATE POLICY workspaces_admin_update ON app.workspaces
  FOR UPDATE TO dsh_app_runtime
  USING (app.workspace_access_allowed(id, 'admin'))
  WITH CHECK (app.workspace_access_allowed(id, 'admin'));

CREATE POLICY workspace_members_member_read ON app.workspace_members
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY workspace_members_admin_write ON app.workspace_members
  FOR ALL TO dsh_app_runtime
  USING (
    app.workspace_owner_is_current_user(workspace_id)
    OR app.workspace_access_allowed(workspace_id, 'admin')
  )
  WITH CHECK (
    app.workspace_owner_is_current_user(workspace_id)
    OR app.workspace_access_allowed(workspace_id, 'admin')
  );

CREATE POLICY novel_novels_member_read ON novel.novels
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_novels_editor_write ON novel.novels
  FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_characters_member_read ON novel.characters
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_characters_editor_write ON novel.characters
  FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_character_versions_member_read ON novel.character_versions
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_character_versions_editor_write ON novel.character_versions
  FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_skills_member_read ON novel.skills
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_skills_editor_write ON novel.skills
  FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_skill_versions_member_read ON novel.skill_versions
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_skill_versions_editor_write ON novel.skill_versions
  FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_character_skills_member_read ON novel.character_skills
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_character_skills_editor_write ON novel.character_skills
  FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_entity_relations_member_read ON novel.entity_relations
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_entity_relations_editor_write ON novel.entity_relations
  FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY ai_runs_member_read ON ai.generation_runs
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY ai_runs_editor_create ON ai.generation_runs
  FOR INSERT TO dsh_app_runtime, dsh_worker_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY ai_proposals_member_read ON ai.generation_proposals
  FOR SELECT TO dsh_app_runtime, dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY ai_proposals_worker_draft_create ON ai.generation_proposals
  FOR INSERT TO dsh_worker_runtime
  WITH CHECK (
    app.workspace_access_allowed(workspace_id, 'editor')
    AND status = 'draft'
  );
CREATE POLICY ai_proposals_worker_draft_update ON ai.generation_proposals
  FOR UPDATE TO dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor') AND status = 'draft')
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor') AND status = 'draft');
CREATE POLICY ai_proposals_reviewer_write ON ai.generation_proposals
  FOR UPDATE TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY audit_append ON security.audit_events
  FOR INSERT TO dsh_auth_runtime, dsh_app_runtime, dsh_worker_runtime, dsh_service_runtime
  WITH CHECK (
    workspace_id IS NULL OR app.workspace_access_allowed(workspace_id, 'member')
  );
CREATE POLICY audit_read ON security.audit_events
  FOR SELECT TO dsh_readonly, dsh_app_runtime
  USING (workspace_id IS NULL OR app.workspace_access_allowed(workspace_id, 'admin'));

-- Runtime roles receive only the tables they need. No runtime role receives CREATE.
REVOKE ALL ON ALL TABLES IN SCHEMA auth, app, novel, ai, security FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON auth.users, auth.sessions, auth.refresh_tokens,
  auth.email_verification_tokens, auth.password_reset_tokens TO dsh_auth_runtime;
GRANT SELECT, INSERT, UPDATE ON app.workspaces, app.workspace_members,
  novel.novels, novel.characters, novel.character_versions, novel.skills,
  novel.skill_versions, novel.character_skills, novel.entity_relations,
  ai.generation_runs, ai.generation_proposals TO dsh_app_runtime;
GRANT SELECT ON novel.novels, novel.characters, novel.character_versions,
  novel.skills, novel.skill_versions, novel.character_skills, novel.entity_relations,
  ai.generation_runs, ai.generation_proposals TO dsh_worker_runtime;
GRANT INSERT, UPDATE ON ai.generation_runs, ai.generation_proposals TO dsh_worker_runtime;
GRANT SELECT ON app.workspaces, app.workspace_members, novel.novels, novel.characters,
  novel.character_versions, novel.skills, novel.skill_versions, novel.character_skills,
  novel.entity_relations, ai.generation_runs, ai.generation_proposals,
  security.audit_events TO dsh_readonly;
GRANT INSERT ON security.audit_events TO dsh_auth_runtime, dsh_app_runtime,
  dsh_worker_runtime, dsh_service_runtime;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth, app, novel, ai, security TO dsh_migrator;
REVOKE CREATE ON SCHEMA auth, app, novel, ai, security
  FROM dsh_auth_runtime, dsh_app_runtime, dsh_worker_runtime, dsh_readonly, dsh_service_runtime;
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.current_service_bypass(),
  app.workspace_access_allowed(UUID, TEXT), app.workspace_owner_is_current_user(UUID)
  TO dsh_auth_runtime, dsh_app_runtime,
  dsh_worker_runtime, dsh_readonly, dsh_service_runtime;

COMMIT;
