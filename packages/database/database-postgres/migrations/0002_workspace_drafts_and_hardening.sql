DO $$
DECLARE migration_role RECORD;
BEGIN
  IF current_user <> 'dsh_migrator' THEN
    RAISE EXCEPTION 'migration 0002 must run as dsh_migrator after the ownership bootstrap';
  END IF;
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
  INTO migration_role FROM pg_roles WHERE rolname = current_user;
  IF migration_role.rolsuper OR migration_role.rolcreatedb OR migration_role.rolcreaterole
    OR migration_role.rolbypassrls THEN
    RAISE EXCEPTION 'dsh_migrator must have deployment-only DDL privileges; run bootstrap-migrator-ownership.sql first';
  END IF;
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, app, novel, ai, security FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dsh_migrator IN SCHEMA auth, app, novel, ai, security, drizzle
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dsh_migrator IN SCHEMA auth, app, novel, ai, security, drizzle
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dsh_migrator IN SCHEMA auth, app, novel, ai, security, drizzle
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER TABLE novel.novels ADD CONSTRAINT novels_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE novel.characters ADD COLUMN source_idempotency_key TEXT;
CREATE UNIQUE INDEX characters_workspace_idempotency_idx
  ON novel.characters(workspace_id, source_idempotency_key);
ALTER TABLE novel.characters ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'archived', 'deleted'));
ALTER TABLE novel.characters ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE novel.characters ADD COLUMN source_generation_run_id UUID;
ALTER TABLE novel.characters ADD CONSTRAINT characters_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE novel.characters ADD CONSTRAINT characters_workspace_novel_id_id_key
  UNIQUE (workspace_id, novel_id, id);
ALTER TABLE novel.characters ADD CONSTRAINT characters_workspace_novel_fkey
  FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);

ALTER TABLE novel.skills ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'archived', 'deleted'));
ALTER TABLE novel.skills ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE novel.skills ADD COLUMN source_generation_run_id UUID;
ALTER TABLE novel.skills ADD COLUMN source_idempotency_key TEXT;
CREATE UNIQUE INDEX skills_workspace_idempotency_idx ON novel.skills(workspace_id, source_idempotency_key);
ALTER TABLE novel.skills ADD CONSTRAINT skills_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE novel.skills ADD CONSTRAINT skills_workspace_novel_id_id_key
  UNIQUE (workspace_id, novel_id, id);
ALTER TABLE novel.skills ADD CONSTRAINT skills_workspace_novel_fkey
  FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);

ALTER TABLE novel.character_versions ADD COLUMN novel_id UUID;
ALTER TABLE novel.character_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'archived', 'deleted'));
ALTER TABLE novel.character_versions ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE novel.character_versions ADD COLUMN source_generation_run_id UUID;
ALTER TABLE novel.character_versions ADD COLUMN source_idempotency_key TEXT;
CREATE UNIQUE INDEX character_versions_workspace_idempotency_idx
  ON novel.character_versions(workspace_id, source_idempotency_key);
UPDATE novel.character_versions AS version
SET novel_id = character.novel_id
FROM novel.characters AS character
WHERE character.id = version.character_id AND character.workspace_id = version.workspace_id;
ALTER TABLE novel.character_versions ALTER COLUMN novel_id SET NOT NULL;
ALTER TABLE novel.character_versions ADD CONSTRAINT character_versions_workspace_novel_character_fkey
  FOREIGN KEY (workspace_id, novel_id, character_id)
  REFERENCES novel.characters(workspace_id, novel_id, id);

ALTER TABLE novel.skill_versions ADD COLUMN novel_id UUID;
ALTER TABLE novel.skill_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'archived', 'deleted'));
ALTER TABLE novel.skill_versions ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE novel.skill_versions ADD COLUMN source_generation_run_id UUID;
ALTER TABLE novel.skill_versions ADD COLUMN source_idempotency_key TEXT;
CREATE UNIQUE INDEX skill_versions_workspace_idempotency_idx
  ON novel.skill_versions(workspace_id, source_idempotency_key);
UPDATE novel.skill_versions AS version
SET novel_id = skill.novel_id
FROM novel.skills AS skill
WHERE skill.id = version.skill_id AND skill.workspace_id = version.workspace_id;
ALTER TABLE novel.skill_versions ALTER COLUMN novel_id SET NOT NULL;
ALTER TABLE novel.skill_versions ADD CONSTRAINT skill_versions_workspace_novel_skill_fkey
  FOREIGN KEY (workspace_id, novel_id, skill_id)
  REFERENCES novel.skills(workspace_id, novel_id, id);

ALTER TABLE ai.generation_runs ADD COLUMN novel_id UUID;
ALTER TABLE ai.generation_runs ADD COLUMN heartbeat_at TIMESTAMPTZ;
ALTER TABLE ai.generation_runs ADD COLUMN error_summary TEXT;
ALTER TABLE ai.generation_runs ADD COLUMN idempotency_key TEXT;
UPDATE ai.generation_runs SET idempotency_key = 'migration-0002:' || id::TEXT WHERE idempotency_key IS NULL;
ALTER TABLE ai.generation_runs ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE ai.generation_runs ADD CONSTRAINT generation_runs_idempotency_key_check
  CHECK (length(btrim(idempotency_key)) > 0);
CREATE UNIQUE INDEX generation_runs_workspace_idempotency_idx
  ON ai.generation_runs(workspace_id, idempotency_key);
ALTER TABLE ai.generation_runs ADD CONSTRAINT generation_runs_workspace_id_id_key UNIQUE (workspace_id, id);
WITH proposal_novels AS (
  SELECT run.id, character.novel_id
  FROM ai.generation_runs AS run
  JOIN ai.generation_proposals AS proposal
    ON proposal.generation_run_id = run.id AND proposal.workspace_id = run.workspace_id
  JOIN novel.characters AS character
    ON proposal.target_type = 'characters' AND proposal.target_id = character.id
      AND proposal.workspace_id = character.workspace_id
  UNION
  SELECT run.id, skill.novel_id
  FROM ai.generation_runs AS run
  JOIN ai.generation_proposals AS proposal
    ON proposal.generation_run_id = run.id AND proposal.workspace_id = run.workspace_id
  JOIN novel.skills AS skill
    ON proposal.target_type = 'skills' AND proposal.target_id = skill.id
      AND proposal.workspace_id = skill.workspace_id
), resolved_proposal_novels AS (
  SELECT id, array_agg(novel_id) AS novel_ids
  FROM proposal_novels
  GROUP BY id
  HAVING count(*) = 1
)
UPDATE ai.generation_runs AS run
SET novel_id = resolved.novel_ids[1]
FROM resolved_proposal_novels AS resolved
WHERE run.id = resolved.id;
WITH single_novel_workspaces AS (
  SELECT workspace_id, array_agg(id) AS novel_ids
  FROM novel.novels
  GROUP BY workspace_id
  HAVING count(*) = 1
)
UPDATE ai.generation_runs AS run
SET novel_id = workspace_novels.novel_ids[1]
FROM single_novel_workspaces AS workspace_novels
WHERE run.novel_id IS NULL AND run.workspace_id = workspace_novels.workspace_id;
UPDATE ai.generation_runs
SET completed_at = started_at
WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at IS NULL;
UPDATE ai.generation_runs SET completed_at = NULL
WHERE status IN ('queued', 'running') AND completed_at IS NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.generation_runs WHERE novel_id IS NULL) THEN
    RAISE EXCEPTION 'cannot infer the novel for existing AI generation runs; assign each run a novel before retrying migration 0002';
  END IF;
END
$$;
ALTER TABLE ai.generation_runs ALTER COLUMN novel_id SET NOT NULL;
ALTER TABLE ai.generation_runs ADD CONSTRAINT generation_runs_workspace_novel_fkey
  FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);
ALTER TABLE ai.generation_runs ADD CONSTRAINT generation_runs_workspace_novel_id_id_key
  UNIQUE (workspace_id, novel_id, id);
ALTER TABLE novel.characters ADD CONSTRAINT characters_workspace_generation_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.skills ADD CONSTRAINT skills_workspace_generation_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
UPDATE ai.generation_runs
SET error_code='LEGACY_ERROR'
WHERE error_code IS NOT NULL AND error_code !~ '^[A-Z][A-Z0-9_]{0,127}$';
ALTER TABLE ai.generation_runs ADD CONSTRAINT generation_runs_completed_at_check
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL));
ALTER TABLE ai.generation_runs ADD CONSTRAINT generation_runs_error_code_length_check
  CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,127}$');
ALTER TABLE ai.generation_runs ADD CONSTRAINT generation_runs_error_summary_length_check
  CHECK (error_summary IS NULL OR length(error_summary) <= 512);
CREATE TABLE novel.locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL, name TEXT NOT NULL, summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (attributes_schema_version > 0),
  current_version_no INTEGER NOT NULL DEFAULT 1 CHECK (current_version_no > 0),
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id), source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, novel_id, id),
  FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id),
  FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id)
);
CREATE TABLE novel.factions (LIKE novel.locations INCLUDING ALL);
CREATE TABLE novel.items (LIKE novel.locations INCLUDING ALL);
CREATE TABLE novel.storylines (LIKE novel.locations INCLUDING ALL);
ALTER TABLE novel.factions ADD CONSTRAINT factions_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);
ALTER TABLE novel.factions ADD CONSTRAINT factions_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);
ALTER TABLE novel.items ADD CONSTRAINT items_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);
ALTER TABLE novel.items ADD CONSTRAINT items_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);
ALTER TABLE novel.storylines ADD CONSTRAINT storylines_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);
ALTER TABLE novel.storylines ADD CONSTRAINT storylines_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);
CREATE INDEX novel_locations_workspace_novel_idx ON novel.locations(workspace_id, novel_id, status);
CREATE INDEX novel_factions_workspace_novel_idx ON novel.factions(workspace_id, novel_id, status);
CREATE INDEX novel_items_workspace_novel_idx ON novel.items(workspace_id, novel_id, status);
CREATE INDEX novel_storylines_workspace_novel_idx ON novel.storylines(workspace_id, novel_id, status);

CREATE TABLE novel.location_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, novel_id UUID NOT NULL,
  location_id UUID NOT NULL, version_no INTEGER NOT NULL CHECK (version_no > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  content_jsonb JSONB NOT NULL, source_type TEXT NOT NULL, source_id UUID,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id), source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, location_id, version_no),
  FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id),
  FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id),
  FOREIGN KEY (workspace_id, novel_id, location_id) REFERENCES novel.locations(workspace_id, novel_id, id)
);
CREATE TABLE novel.faction_versions (LIKE novel.location_versions INCLUDING ALL);
CREATE TABLE novel.item_versions (LIKE novel.location_versions INCLUDING ALL);
CREATE TABLE novel.storyline_versions (LIKE novel.location_versions INCLUDING ALL);
ALTER TABLE novel.faction_versions RENAME COLUMN location_id TO faction_id;
ALTER TABLE novel.item_versions RENAME COLUMN location_id TO item_id;
ALTER TABLE novel.storyline_versions RENAME COLUMN location_id TO storyline_id;
ALTER TABLE novel.faction_versions ADD CONSTRAINT faction_versions_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);
ALTER TABLE novel.faction_versions ADD CONSTRAINT faction_versions_user_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE novel.faction_versions ADD CONSTRAINT faction_versions_entity_fkey FOREIGN KEY (workspace_id, novel_id, faction_id) REFERENCES novel.factions(workspace_id, novel_id, id);
ALTER TABLE novel.item_versions ADD CONSTRAINT item_versions_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);
ALTER TABLE novel.item_versions ADD CONSTRAINT item_versions_user_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE novel.item_versions ADD CONSTRAINT item_versions_entity_fkey FOREIGN KEY (workspace_id, novel_id, item_id) REFERENCES novel.items(workspace_id, novel_id, id);
ALTER TABLE novel.storyline_versions ADD CONSTRAINT storyline_versions_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);
ALTER TABLE novel.storyline_versions ADD CONSTRAINT storyline_versions_user_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE novel.storyline_versions ADD CONSTRAINT storyline_versions_entity_fkey FOREIGN KEY (workspace_id, novel_id, storyline_id) REFERENCES novel.storylines(workspace_id, novel_id, id);
ALTER TABLE novel.locations ADD CONSTRAINT locations_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.factions ADD CONSTRAINT factions_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.items ADD CONSTRAINT items_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.storylines ADD CONSTRAINT storylines_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['locations','factions','items','storylines','location_versions',
    'faction_versions','item_versions','storyline_versions'] LOOP
    EXECUTE format('CREATE UNIQUE INDEX %I ON novel.%I(workspace_id,source_idempotency_key)',
      table_name||'_workspace_idempotency_idx', table_name);
  END LOOP;
END
$$;
ALTER TABLE novel.character_versions ADD CONSTRAINT character_versions_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.skill_versions ADD CONSTRAINT skill_versions_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.location_versions ADD CONSTRAINT location_versions_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.faction_versions ADD CONSTRAINT faction_versions_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.item_versions ADD CONSTRAINT item_versions_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.storyline_versions ADD CONSTRAINT storyline_versions_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
CREATE INDEX novel_character_versions_workspace_entity_idx ON novel.character_versions(workspace_id, novel_id, character_id, version_no DESC);
CREATE INDEX novel_skill_versions_workspace_entity_idx ON novel.skill_versions(workspace_id, novel_id, skill_id, version_no DESC);
CREATE INDEX novel_location_versions_workspace_entity_idx ON novel.location_versions(workspace_id, novel_id, location_id, version_no DESC);
CREATE INDEX novel_faction_versions_workspace_entity_idx ON novel.faction_versions(workspace_id, novel_id, faction_id, version_no DESC);
CREATE INDEX novel_item_versions_workspace_entity_idx ON novel.item_versions(workspace_id, novel_id, item_id, version_no DESC);
CREATE INDEX novel_storyline_versions_workspace_entity_idx ON novel.storyline_versions(workspace_id, novel_id, storyline_id, version_no DESC);

ALTER TABLE novel.character_skills ADD COLUMN novel_id UUID;
ALTER TABLE novel.character_skills ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'archived', 'deleted'));
ALTER TABLE novel.character_skills ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE novel.character_skills ADD COLUMN attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE novel.character_skills ADD COLUMN attributes_schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (attributes_schema_version > 0);
ALTER TABLE novel.character_skills ADD COLUMN current_version_no INTEGER NOT NULL DEFAULT 1
  CHECK (current_version_no > 0);
ALTER TABLE novel.character_skills ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE novel.character_skills ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE novel.character_skills ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE novel.character_skills ADD CONSTRAINT character_skills_workspace_novel_id_id_key
  UNIQUE (workspace_id, novel_id, id);
ALTER TABLE novel.character_skills ADD COLUMN created_by_user_id UUID REFERENCES auth.users(id);
ALTER TABLE novel.character_skills ADD COLUMN source_generation_run_id UUID;
ALTER TABLE novel.character_skills ADD COLUMN source_idempotency_key TEXT;
UPDATE novel.character_skills AS link
SET novel_id = character.novel_id, created_by_user_id = character.created_by_user_id
FROM novel.characters AS character
WHERE character.id = link.character_id AND character.workspace_id = link.workspace_id;
ALTER TABLE novel.character_skills ALTER COLUMN novel_id SET NOT NULL;
ALTER TABLE novel.character_skills ALTER COLUMN created_by_user_id SET NOT NULL;
ALTER TABLE novel.character_skills DROP CONSTRAINT character_skills_pkey;
ALTER TABLE novel.character_skills ADD CONSTRAINT character_skills_pkey
  PRIMARY KEY (workspace_id, novel_id, character_id, skill_id);
ALTER TABLE novel.character_skills ADD CONSTRAINT character_skills_workspace_character_fkey
  FOREIGN KEY (workspace_id, novel_id, character_id) REFERENCES novel.characters(workspace_id, novel_id, id);
ALTER TABLE novel.character_skills ADD CONSTRAINT character_skills_workspace_skill_fkey
  FOREIGN KEY (workspace_id, novel_id, skill_id) REFERENCES novel.skills(workspace_id, novel_id, id);
ALTER TABLE novel.character_skills ADD CONSTRAINT character_skills_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);
ALTER TABLE novel.character_skills ADD CONSTRAINT character_skills_creator_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE novel.character_skills ADD CONSTRAINT character_skills_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
CREATE UNIQUE INDEX character_skills_workspace_idempotency_idx
  ON novel.character_skills(workspace_id, source_idempotency_key);
CREATE TABLE novel.character_skill_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, novel_id UUID NOT NULL,
  character_skill_id UUID NOT NULL, version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content_jsonb JSONB NOT NULL, source_type TEXT NOT NULL, source_id UUID,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id), source_generation_run_id UUID,
  source_idempotency_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT character_skill_versions_workspace_entity_version_key
    UNIQUE (workspace_id, character_skill_id, version_no),
  CONSTRAINT character_skill_versions_version_no_check CHECK (version_no > 0),
  CONSTRAINT character_skill_versions_status_check
    CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  FOREIGN KEY (workspace_id, novel_id, character_skill_id)
    REFERENCES novel.character_skills(workspace_id, novel_id, id),
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id)
);
CREATE UNIQUE INDEX character_skill_versions_workspace_idempotency_idx
  ON novel.character_skill_versions(workspace_id, source_idempotency_key);
INSERT INTO novel.character_skill_versions(
  workspace_id, novel_id, character_skill_id, version_no, status, content_jsonb, source_type, created_by_user_id, created_at
)
SELECT workspace_id, novel_id, id, 1, status,
  jsonb_build_object('relation_type', relation_type, 'source_version_no', source_version_no,
    'attributes_jsonb', attributes_jsonb, 'attributes_schema_version', attributes_schema_version),
  'migration', created_by_user_id, created_at
FROM novel.character_skills;
CREATE INDEX character_skill_versions_workspace_entity_idx
  ON novel.character_skill_versions(workspace_id, novel_id, character_skill_id, version_no DESC);

ALTER TABLE novel.entity_relations ADD COLUMN novel_id UUID;
ALTER TABLE novel.entity_relations ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published', 'archived', 'deleted'));
ALTER TABLE novel.entity_relations ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE novel.entity_relations ADD COLUMN attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE novel.entity_relations ADD COLUMN attributes_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (attributes_schema_version > 0);
ALTER TABLE novel.entity_relations ADD COLUMN current_version_no INTEGER NOT NULL DEFAULT 1 CHECK (current_version_no > 0);
ALTER TABLE novel.entity_relations ADD COLUMN source_generation_run_id UUID;
ALTER TABLE novel.entity_relations ADD COLUMN source_idempotency_key TEXT;
ALTER TABLE novel.entity_relations ADD COLUMN deleted_at TIMESTAMPTZ;
UPDATE novel.entity_relations relation SET novel_id = character.novel_id
FROM novel.characters character
WHERE relation.source_entity_type = 'characters' AND relation.source_entity_id = character.id AND relation.workspace_id = character.workspace_id;
UPDATE novel.entity_relations relation SET novel_id = skill.novel_id
FROM novel.skills skill
WHERE relation.novel_id IS NULL AND relation.source_entity_type = 'skills'
  AND relation.source_entity_id = skill.id AND relation.workspace_id = skill.workspace_id;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM novel.entity_relations WHERE novel_id IS NULL) THEN
    RAISE EXCEPTION 'cannot infer the novel for an existing entity relation; repair its source entity before retrying migration 0002';
  END IF;
END
$$;
ALTER TABLE novel.entity_relations ALTER COLUMN novel_id SET NOT NULL;
ALTER TABLE novel.entity_relations ADD CONSTRAINT entity_relations_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE novel.entity_relations ADD CONSTRAINT entity_relations_workspace_novel_id_id_key UNIQUE (workspace_id, novel_id, id);
ALTER TABLE novel.entity_relations ADD CONSTRAINT entity_relations_workspace_novel_fkey
  FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);
ALTER TABLE novel.entity_relations ADD CONSTRAINT entity_relations_creator_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE novel.entity_relations ADD CONSTRAINT entity_relations_entity_types_check
  CHECK (source_entity_type IN ('characters', 'skills', 'locations', 'factions', 'items', 'storylines')
    AND target_entity_type IN ('characters', 'skills', 'locations', 'factions', 'items', 'storylines'));
CREATE TABLE novel.entity_relation_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL, relation_id UUID NOT NULL, version_no INTEGER NOT NULL CHECK (version_no > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  content_jsonb JSONB NOT NULL, source_type TEXT NOT NULL, source_id UUID,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id), source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, relation_id, version_no),
  FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id),
  FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id),
  FOREIGN KEY (workspace_id, novel_id, relation_id) REFERENCES novel.entity_relations(workspace_id, novel_id, id)
);
ALTER TABLE novel.entity_relations ADD CONSTRAINT entity_relations_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE novel.entity_relation_versions ADD CONSTRAINT entity_relation_versions_run_fkey
  FOREIGN KEY (workspace_id, novel_id, source_generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
CREATE UNIQUE INDEX entity_relations_workspace_idempotency_idx
  ON novel.entity_relations(workspace_id, source_idempotency_key);
CREATE UNIQUE INDEX entity_relation_versions_workspace_idempotency_idx
  ON novel.entity_relation_versions(workspace_id, source_idempotency_key);

ALTER TABLE ai.generation_proposals ADD COLUMN novel_id UUID;
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_workspace_id_id_key UNIQUE (workspace_id, id);
UPDATE ai.generation_proposals proposal SET novel_id = run.novel_id
FROM ai.generation_runs run
WHERE proposal.generation_run_id = run.id AND proposal.workspace_id = run.workspace_id;
ALTER TABLE ai.generation_proposals ALTER COLUMN novel_id SET NOT NULL;
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_workspace_novel_run_fkey
  FOREIGN KEY (workspace_id, novel_id, generation_run_id) REFERENCES ai.generation_runs(workspace_id, novel_id, id);
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_workspace_novel_fkey
  FOREIGN KEY (workspace_id, novel_id) REFERENCES novel.novels(workspace_id, id);
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_target_type_check
  CHECK (target_type IN ('characters', 'skills', 'locations', 'factions', 'items', 'storylines', 'entity_relations', 'character_skills'));
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_operation_check
  CHECK (operation IN ('create', 'update', 'link'));
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.generation_proposals
    WHERE target_type='character_skills' AND operation NOT IN ('link','update')) THEN
    RAISE EXCEPTION 'cannot migrate a character-skill proposal with an unsupported operation; repair it before applying migration 0002';
  END IF;
END
$$;
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_character_skill_operation_check
  CHECK (target_type <> 'character_skills' OR operation IN ('link','update'));
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_target_check
  CHECK ((target_id IS NOT NULL AND ((operation IN ('create', 'link') AND base_version_no IS NULL)
    OR (operation = 'update' AND base_version_no > 0)))
    OR (status = 'draft' AND operation = 'create' AND target_id IS NULL AND base_version_no IS NULL));
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai.generation_proposals
    WHERE operation='create' AND target_id IS NULL AND status <> 'draft') THEN
    RAISE EXCEPTION 'cannot migrate an unbound non-draft create proposal; repair its target before applying migration 0002';
  END IF;
END
$$;
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_idempotency_key_check
  CHECK (length(btrim(idempotency_key)) > 0);

CREATE OR REPLACE FUNCTION app.current_workspace_id() RETURNS UUID
LANGUAGE plpgsql STABLE AS $$
DECLARE configured_id TEXT := current_setting('app.workspace_id', true);
BEGIN
  IF configured_id IS NULL OR configured_id = '' THEN RETURN NULL; END IF;
  RETURN configured_id::UUID;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION app.current_actor_type() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.actor_type', true), '') $$;
CREATE OR REPLACE FUNCTION app.current_agent_principal_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.agent_principal_id', true), '') $$;
CREATE OR REPLACE FUNCTION app.current_database_role() RETURNS TEXT
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    CASE WHEN current_setting('role', true) = ANY(ARRAY[
      'dsh_worker_runtime', 'dsh_app_runtime', 'dsh_service_runtime', 'dsh_auth_runtime', 'dsh_readonly'
    ]) AND pg_has_role(session_user, current_setting('role', true), 'MEMBER') THEN current_setting('role', true) END,
    (SELECT role_name FROM unnest(ARRAY[
      'dsh_worker_runtime', 'dsh_app_runtime', 'dsh_service_runtime', 'dsh_auth_runtime', 'dsh_readonly'
    ]) AS roles(role_name)
      WHERE pg_has_role(session_user, role_name, 'MEMBER')
      ORDER BY CASE role_name WHEN 'dsh_worker_runtime' THEN 1 WHEN 'dsh_app_runtime' THEN 2
        WHEN 'dsh_service_runtime' THEN 3 WHEN 'dsh_auth_runtime' THEN 4 ELSE 5 END LIMIT 1)
  )
$$;
CREATE OR REPLACE FUNCTION app.workspace_access_allowed(requested_workspace_id UUID, minimum_role TEXT DEFAULT 'member')
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT requested_workspace_id = app.current_workspace_id() AND EXISTS (
    SELECT 1 FROM app.workspace_members member
    WHERE member.workspace_id = requested_workspace_id AND member.user_id = app.current_user_id()
      AND member.revoked_at IS NULL AND CASE minimum_role
        WHEN 'member' THEN member.role IN ('member', 'editor', 'admin', 'owner')
        WHEN 'editor' THEN member.role IN ('editor', 'admin', 'owner')
        WHEN 'admin' THEN member.role IN ('admin', 'owner')
        WHEN 'owner' THEN member.role = 'owner' ELSE FALSE END)
$$;
CREATE OR REPLACE FUNCTION app.guard_workspace_owner_changes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'dsh_app_runtime' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'workspaces' THEN
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='workspace ownership changes require a dedicated owner-transfer operation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='workspace owner membership cannot be deleted';
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner' THEN
      IF NOT app.workspace_owner_is_current_user(NEW.workspace_id)
        OR NEW.user_id IS DISTINCT FROM app.current_user_id() THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='only the recorded workspace owner may grant the owner role';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.role = 'owner' THEN
    IF NOT app.workspace_owner_is_current_user(OLD.workspace_id)
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.role IS DISTINCT FROM OLD.role OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='workspace owner membership requires a dedicated owner-transfer operation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.role = 'owner' THEN
    IF NOT app.workspace_owner_is_current_user(NEW.workspace_id)
      OR NEW.user_id IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='only the recorded workspace owner may retain the owner role';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER workspaces_guard_owner_changes BEFORE UPDATE ON app.workspaces
  FOR EACH ROW EXECUTE FUNCTION app.guard_workspace_owner_changes();
CREATE TRIGGER workspace_members_guard_owner_changes BEFORE INSERT OR UPDATE OR DELETE ON app.workspace_members
  FOR EACH ROW EXECUTE FUNCTION app.guard_workspace_owner_changes();
CREATE OR REPLACE FUNCTION app.transfer_workspace_owner(requested_workspace_id UUID, new_owner_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, auth, security AS $$
DECLARE previous_owner_user_id UUID;
BEGIN
  IF app.current_database_role() <> 'dsh_app_runtime'
    OR requested_workspace_id IS DISTINCT FROM app.current_workspace_id()
    OR NOT app.workspace_access_allowed(requested_workspace_id, 'owner') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='only the authenticated workspace owner may transfer ownership';
  END IF;
  SELECT workspace.owner_user_id INTO previous_owner_user_id
  FROM app.workspaces workspace WHERE workspace.id=requested_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='workspace does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=new_owner_user_id
    AND status='active' AND email_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='new owner must be an active verified user';
  END IF;
  UPDATE app.workspace_members SET role='admin'
  WHERE workspace_id=requested_workspace_id AND user_id=previous_owner_user_id AND revoked_at IS NULL;
  INSERT INTO app.workspace_members(workspace_id,user_id,role,revoked_at)
  VALUES (requested_workspace_id,new_owner_user_id,'owner',NULL)
  ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='owner',revoked_at=NULL;
  UPDATE app.workspaces SET owner_user_id=new_owner_user_id,updated_at=now()
  WHERE id=requested_workspace_id;
  INSERT INTO security.audit_events(workspace_id,actor_type,actor_id,action,target_type,target_id,metadata)
  VALUES (requested_workspace_id,'user',app.current_user_id()::TEXT,'workspace_owner_transferred',
    'workspace',requested_workspace_id::TEXT,jsonb_build_object('previous_owner_user_id',previous_owner_user_id,
      'new_owner_user_id',new_owner_user_id));
END
$$;
REVOKE EXECUTE ON FUNCTION app.transfer_workspace_owner(UUID,UUID) FROM PUBLIC;
CREATE OR REPLACE FUNCTION app.agent_run_allowed(
  requested_workspace_id UUID, requested_novel_id UUID, requested_run_id UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, ai AS $$
  SELECT app.current_database_role() = 'dsh_worker_runtime' AND app.current_actor_type() = 'agent'
    AND requested_workspace_id = app.current_workspace_id() AND EXISTS (
  SELECT 1 FROM ai.generation_runs run WHERE run.id = requested_run_id
        AND run.workspace_id = requested_workspace_id AND run.novel_id = requested_novel_id
        AND run.initiated_by_user_id = app.current_user_id()
        AND run.source_session_id IS NOT NULL
        AND run.agent_principal_id = app.current_agent_principal_id()
        AND app.workspace_access_allowed(requested_workspace_id, 'editor'))
$$;
CREATE OR REPLACE FUNCTION novel.entity_reference_exists(requested_type TEXT, requested_id UUID,
  requested_workspace_id UUID, requested_novel_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, novel AS $$
BEGIN
  CASE requested_type
    WHEN 'characters' THEN RETURN EXISTS (SELECT 1 FROM novel.characters WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    WHEN 'skills' THEN RETURN EXISTS (SELECT 1 FROM novel.skills WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    WHEN 'locations' THEN RETURN EXISTS (SELECT 1 FROM novel.locations WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    WHEN 'factions' THEN RETURN EXISTS (SELECT 1 FROM novel.factions WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    WHEN 'items' THEN RETURN EXISTS (SELECT 1 FROM novel.items WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    WHEN 'storylines' THEN RETURN EXISTS (SELECT 1 FROM novel.storylines WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    WHEN 'entity_relations' THEN RETURN EXISTS (SELECT 1 FROM novel.entity_relations WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    WHEN 'character_skills' THEN RETURN EXISTS (SELECT 1 FROM novel.character_skills WHERE id=requested_id AND workspace_id=requested_workspace_id AND novel_id=requested_novel_id);
    ELSE RETURN FALSE;
  END CASE;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM novel.entity_relations relation
    WHERE NOT novel.entity_reference_exists(relation.source_entity_type, relation.source_entity_id,
      relation.workspace_id, relation.novel_id)
      OR NOT novel.entity_reference_exists(relation.target_entity_type, relation.target_entity_id,
        relation.workspace_id, relation.novel_id)
  ) THEN
    RAISE EXCEPTION 'cannot migrate an entity relation that crosses a workspace or novel; repair its endpoints before applying migration 0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ai.generation_proposals proposal
    WHERE proposal.target_id IS NOT NULL
      AND NOT novel.entity_reference_exists(proposal.target_type, proposal.target_id,
        proposal.workspace_id, proposal.novel_id)
  ) THEN
    RAISE EXCEPTION 'cannot migrate a proposal that references an entity outside its workspace or novel; repair its target before applying migration 0002';
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION novel.validate_entity_relation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, novel AS $$
BEGIN
  IF NOT novel.entity_reference_exists(NEW.source_entity_type, NEW.source_entity_id, NEW.workspace_id, NEW.novel_id)
    OR NOT novel.entity_reference_exists(NEW.target_entity_type, NEW.target_entity_id, NEW.workspace_id, NEW.novel_id) THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='entity relation references an entity outside its workspace or novel';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER entity_relations_validate_reference BEFORE INSERT OR UPDATE ON novel.entity_relations
  FOR EACH ROW EXECUTE FUNCTION novel.validate_entity_relation();
CREATE OR REPLACE FUNCTION ai.validate_generation_proposal() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ai, novel AS $$
BEGIN
  IF NEW.target_id IS NULL THEN
    IF NEW.status = 'draft' AND NEW.operation = 'create' THEN RETURN NEW; END IF;
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='reviewable generation proposals require an existing draft target';
  END IF;
  IF NOT novel.entity_reference_exists(NEW.target_type, NEW.target_id, NEW.workspace_id, NEW.novel_id) THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='generation proposal target is outside its workspace or novel';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER generation_proposals_validate_reference BEFORE INSERT OR UPDATE ON ai.generation_proposals
  FOR EACH ROW EXECUTE FUNCTION ai.validate_generation_proposal();

CREATE OR REPLACE FUNCTION novel.entity_payload_matches(
  requested_type TEXT, row_content JSONB, proposed_content JSONB
)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE requested_type
    WHEN 'character_skills' THEN proposed_content = jsonb_build_object(
      'character_id', row_content->'character_id', 'skill_id', row_content->'skill_id',
      'relation_type', row_content->'relation_type', 'source_version_no', row_content->'source_version_no',
      'attributes_jsonb', row_content->'attributes_jsonb',
      'attributes_schema_version', row_content->'attributes_schema_version')
    ELSE requested_type IN ('characters','skills','locations','factions','items','storylines','entity_relations')
      AND proposed_content = row_content - ARRAY['id','workspace_id','novel_id','status','current_version_no',
        'created_by_user_id','source_generation_run_id','source_idempotency_key','created_at','updated_at','deleted_at']
  END
$$;
REVOKE EXECUTE ON FUNCTION novel.entity_payload_matches(TEXT,JSONB,JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION novel.approved_version_exists(
  requested_type TEXT, requested_target_id UUID, requested_workspace_id UUID,
  requested_novel_id UUID, requested_version_no INTEGER, requested_proposal_id UUID,
  requested_version_status TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, novel, ai AS $$
DECLARE
  version_table TEXT;
  entity_column TEXT;
  version_matches BOOLEAN;
BEGIN
  version_table := CASE requested_type
    WHEN 'characters' THEN 'character_versions'
    WHEN 'skills' THEN 'skill_versions'
    WHEN 'locations' THEN 'location_versions'
    WHEN 'factions' THEN 'faction_versions'
    WHEN 'items' THEN 'item_versions'
    WHEN 'storylines' THEN 'storyline_versions'
    WHEN 'entity_relations' THEN 'entity_relation_versions'
    WHEN 'character_skills' THEN 'character_skill_versions'
    ELSE NULL
  END;
  entity_column := CASE requested_type
    WHEN 'characters' THEN 'character_id'
    WHEN 'skills' THEN 'skill_id'
    WHEN 'locations' THEN 'location_id'
    WHEN 'factions' THEN 'faction_id'
    WHEN 'items' THEN 'item_id'
    WHEN 'storylines' THEN 'storyline_id'
    WHEN 'entity_relations' THEN 'relation_id'
    WHEN 'character_skills' THEN 'character_skill_id'
    ELSE NULL
  END;
  IF version_table IS NULL THEN RETURN FALSE; END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM novel.%I AS version JOIN ai.generation_proposals AS proposal ON proposal.id=$1
      WHERE version.%I=$2 AND version.workspace_id=$3 AND version.novel_id=$4
        AND version.version_no=$5 AND version.status=$7
        AND version.source_generation_run_id IS NOT DISTINCT FROM proposal.generation_run_id
        AND proposal.target_type=$6 AND proposal.target_id=$2 AND proposal.workspace_id=$3 AND proposal.novel_id=$4
        AND proposal.status=''approved'' AND proposal.reviewed_by_user_id IS NOT NULL
        AND proposal.reviewed_at IS NOT NULL AND proposal.published_at IS NULL
        AND proposal.proposed_content=version.content_jsonb
        AND ((proposal.operation IN (''create'',''link'') AND proposal.base_version_no IS NULL AND version.version_no=1)
          OR (proposal.operation=''update'' AND proposal.base_version_no=version.version_no-1)))',
    version_table, entity_column
  ) INTO version_matches USING requested_proposal_id, requested_target_id, requested_workspace_id,
    requested_novel_id, requested_version_no, requested_type, requested_version_status;
  RETURN version_matches;
END
$$;
REVOKE EXECUTE ON FUNCTION novel.approved_version_exists(TEXT,UUID,UUID,UUID,INTEGER,UUID,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION novel.guard_draft_publication() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE approved_proposal RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND current_user NOT IN ('dsh_service_runtime', 'dsh_migrator') THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='new novel records must be drafts';
    END IF;
    IF current_user = 'dsh_worker_runtime'
      AND (NEW.source_idempotency_key IS NULL OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
        OR NEW.source_generation_run_id IS NULL
        OR NOT app.agent_run_allowed(NEW.workspace_id, NEW.novel_id, NEW.source_generation_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers must provide their own run and idempotency key';
    END IF;
    RETURN NEW;
  END IF;
  IF app.current_database_role() = 'dsh_worker_runtime'
    AND (NEW.status <> 'draft' OR COALESCE(OLD.status, 'draft') <> 'draft'
      OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
      OR NEW.source_idempotency_key IS NULL
      OR NEW.source_generation_run_id IS NULL
      OR NOT app.agent_run_allowed(NEW.workspace_id, NEW.novel_id, NEW.source_generation_run_id)) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers may only write their own draft records';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.source_generation_run_id IS DISTINCT FROM OLD.source_generation_run_id
    OR NEW.source_idempotency_key IS DISTINCT FROM OLD.source_idempotency_key) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='novel record ownership is immutable';
  END IF;
  IF NEW.status = 'published' AND current_user NOT IN ('dsh_service_runtime', 'dsh_migrator') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='publishing novel records requires the review service';
  END IF;
  IF TG_TABLE_NAME IN ('characters','skills','locations','factions','items','storylines','entity_relations','character_skills')
    AND NEW.status='draft' AND NEW.current_version_no IS DISTINCT FROM OLD.current_version_no THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='draft version numbers advance only during reviewed publication';
  END IF;
  IF current_user='dsh_app_runtime' AND OLD.status='draft' AND NEW.status='draft'
    AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at'
    AND (SELECT count(*) FROM ai.generation_proposals proposal
      WHERE proposal.workspace_id=OLD.workspace_id AND proposal.novel_id=OLD.novel_id
        AND proposal.target_id=OLD.id AND proposal.target_type=TG_TABLE_NAME
        AND proposal.operation=CASE WHEN TG_TABLE_NAME='character_skills' THEN 'link' ELSE 'create' END
        AND proposal.status='draft') = 0 THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='draft entity edits require an existing draft proposal';
  END IF;
  IF current_user = 'dsh_app_runtime' THEN
    IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'archived', 'deleted') THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='published records cannot return to draft';
    END IF;
    IF OLD.status IN ('draft', 'published') AND NEW.status IN ('archived', 'deleted')
      AND to_jsonb(NEW) - 'status' - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'updated_at' THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='archiving cannot modify novel record content';
    END IF;
    IF OLD.status = 'published'
      AND to_jsonb(NEW) - 'status' - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'updated_at'
      AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='published record changes require a new reviewed version';
    END IF;
  END IF;
  IF current_user = 'dsh_service_runtime' THEN
    IF TG_TABLE_NAME NOT IN ('character_versions','skill_versions','location_versions','faction_versions',
      'item_versions','storyline_versions','entity_relation_versions') THEN
      SELECT proposal.* INTO approved_proposal FROM ai.generation_proposals proposal
      WHERE proposal.workspace_id=OLD.workspace_id AND proposal.novel_id=OLD.novel_id
        AND proposal.target_type=TG_TABLE_NAME AND proposal.target_id=OLD.id AND proposal.status='approved'
        AND proposal.reviewed_by_user_id IS NOT NULL AND proposal.reviewed_at IS NOT NULL
        AND proposal.published_at IS NULL
        AND ((OLD.status='draft' AND proposal.operation=CASE WHEN TG_TABLE_NAME='character_skills' THEN 'link' ELSE 'create' END
            AND proposal.base_version_no IS NULL AND NEW.current_version_no=OLD.current_version_no)
          OR (OLD.status='published' AND proposal.operation='update'
            AND proposal.base_version_no=OLD.current_version_no
            AND NEW.current_version_no=OLD.current_version_no+1));
      IF NOT FOUND OR NEW.status <> 'published'
        OR (OLD.status='draft' AND NEW.current_version_no IS DISTINCT FROM OLD.current_version_no)
        OR (OLD.status='published' AND NEW.current_version_no IS DISTINCT FROM OLD.current_version_no+1)
        OR NOT novel.approved_version_exists(TG_TABLE_NAME, OLD.id, OLD.workspace_id, OLD.novel_id,
          NEW.current_version_no, approved_proposal.id, 'published')
        OR NOT novel.entity_payload_matches(TG_TABLE_NAME, to_jsonb(NEW), approved_proposal.proposed_content) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='publishing a novel record requires its approved proposal and matching base version';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION novel.guard_version_publication() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  publication_target_type TEXT;
  publication_target_id UUID;
  approved_proposal RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND current_user NOT IN ('dsh_service_runtime', 'dsh_migrator') THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='new novel versions must be drafts';
    END IF;
    IF current_user = 'dsh_worker_runtime'
      AND (NEW.source_idempotency_key IS NULL OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
        OR NEW.source_generation_run_id IS NULL
        OR NOT app.agent_run_allowed(NEW.workspace_id, NEW.novel_id, NEW.source_generation_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers must provide their own run and version idempotency key';
    END IF;
    IF current_user = 'dsh_service_runtime' THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='the review service must publish the existing draft version';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user IN ('dsh_app_runtime', 'dsh_worker_runtime') THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'draft'
      OR to_jsonb(NEW) - 'content_jsonb' IS DISTINCT FROM to_jsonb(OLD) - 'content_jsonb' THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='only the content of a draft novel version may be edited';
    END IF;
    IF current_user='dsh_worker_runtime' AND (NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
      OR NEW.source_generation_run_id IS NULL
      OR NOT app.agent_run_allowed(NEW.workspace_id, NEW.novel_id, NEW.source_generation_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers may only edit versions for their own generation run';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user = 'dsh_service_runtime' THEN
    publication_target_type := CASE TG_TABLE_NAME
      WHEN 'character_skill_versions' THEN 'character_skills'
      WHEN 'character_versions' THEN 'characters'
      WHEN 'skill_versions' THEN 'skills'
      WHEN 'location_versions' THEN 'locations'
      WHEN 'faction_versions' THEN 'factions'
      WHEN 'item_versions' THEN 'items'
      WHEN 'storyline_versions' THEN 'storylines'
      WHEN 'entity_relation_versions' THEN 'entity_relations'
    END;
    publication_target_id := CASE TG_TABLE_NAME
      WHEN 'character_skill_versions' THEN NEW.character_skill_id
      WHEN 'character_versions' THEN NEW.character_id
      WHEN 'skill_versions' THEN NEW.skill_id
      WHEN 'location_versions' THEN NEW.location_id
      WHEN 'faction_versions' THEN NEW.faction_id
      WHEN 'item_versions' THEN NEW.item_id
      WHEN 'storyline_versions' THEN NEW.storyline_id
      WHEN 'entity_relation_versions' THEN NEW.relation_id
    END;
    SELECT proposal.* INTO approved_proposal FROM ai.generation_proposals proposal
    WHERE proposal.workspace_id=NEW.workspace_id AND proposal.novel_id=NEW.novel_id
      AND proposal.target_type=publication_target_type AND proposal.target_id=publication_target_id
      AND proposal.status='approved' AND proposal.reviewed_by_user_id IS NOT NULL AND proposal.reviewed_at IS NOT NULL
      AND proposal.published_at IS NULL AND proposal.proposed_content=OLD.content_jsonb
      AND ((proposal.operation IN ('create','link') AND proposal.base_version_no IS NULL AND OLD.version_no=1)
        OR (proposal.operation='link' AND proposal.base_version_no IS NULL AND OLD.version_no=1)
        OR (proposal.operation='update' AND proposal.base_version_no=OLD.version_no-1));
    IF OLD.status <> 'draft' OR NEW.status <> 'published' OR NOT FOUND
      OR to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status' THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='publishing a version requires its exact approved proposal and unchanged draft content';
    END IF;
    IF NOT novel.approved_version_exists(publication_target_type, publication_target_id,
      NEW.workspace_id, NEW.novel_id, NEW.version_no, approved_proposal.id, 'draft') THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='the draft version must match the approved proposal before publication';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['characters','character_versions','skills','skill_versions','character_skills','character_skill_versions',
    'entity_relations','entity_relation_versions','locations','location_versions','factions','faction_versions',
    'items','item_versions','storylines','storyline_versions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON novel.%I FOR EACH ROW EXECUTE FUNCTION novel.guard_draft_publication()',
      table_name||'_guard_publication', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['character_versions','skill_versions','location_versions','faction_versions',
    'item_versions','storyline_versions','entity_relation_versions','character_skill_versions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON novel.%I FOR EACH ROW EXECUTE FUNCTION novel.guard_version_publication()',
      table_name||'_guard_version_publication', table_name);
  END LOOP;
END
$$;
CREATE OR REPLACE FUNCTION ai.guard_generation_run_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IN ('dsh_app_runtime', 'dsh_worker_runtime') THEN
      IF NEW.status <> 'queued' OR NEW.source_session_id IS NULL OR NEW.idempotency_key IS NULL
        OR NEW.initiated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='new generation runs require the authenticated user, source session, and idempotency key';
      END IF;
      IF current_user = 'dsh_worker_runtime'
        AND NEW.agent_principal_id IS DISTINCT FROM app.current_agent_principal_id() THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers cannot create runs for another agent';
      END IF;
      IF NEW.heartbeat_at IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.error_summary IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='new generation runs cannot contain worker progress or errors';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF current_user = 'dsh_worker_runtime' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
      OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
      OR NEW.agent_principal_id IS DISTINCT FROM OLD.agent_principal_id OR NEW.model IS DISTINCT FROM OLD.model
      OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR (NEW.error_code IS NOT NULL AND NEW.error_code !~ '^[A-Z][A-Z0-9_]{0,127}$') THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers cannot change run ownership or inputs';
    END IF;
    IF NOT ((OLD.status='queued' AND NEW.status='running')
      OR (OLD.status='running' AND NEW.status IN ('running','completed','failed','cancelled'))) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='invalid generation run state transition';
    END IF;
    IF (NEW.status='running' AND NEW.completed_at IS NOT NULL)
      OR (NEW.status='completed' AND NEW.completed_at IS NULL)
      OR (NEW.status='running' AND NEW.heartbeat_at IS NULL)
      OR (OLD.heartbeat_at IS NOT NULL AND (NEW.heartbeat_at IS NULL OR NEW.heartbeat_at < OLD.heartbeat_at))
      OR (NEW.heartbeat_at IS NOT NULL AND NEW.heartbeat_at > statement_timestamp())
      OR (NEW.completed_at IS NOT NULL AND NEW.completed_at > statement_timestamp()) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='generation run completion time must match its terminal status';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER generation_runs_guard_transition BEFORE INSERT OR UPDATE ON ai.generation_runs
  FOR EACH ROW EXECUTE FUNCTION ai.guard_generation_run_transition();
CREATE OR REPLACE FUNCTION ai.guard_generation_proposal_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'draft' OR current_user NOT IN ('dsh_worker_runtime', 'dsh_migrator') THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='new proposals must be worker-created drafts';
    END IF;
    IF current_user='dsh_worker_runtime' AND (NEW.target_id IS NULL OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL OR NEW.published_at IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='worker proposals require a target and cannot contain review metadata';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user='dsh_worker_runtime' AND NEW.status<>'draft' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers may only maintain draft proposals';
  END IF;
  IF current_user='dsh_app_runtime' AND NOT (
    (OLD.status='draft' AND NEW.status IN ('draft','approved','rejected','expired'))
    OR (OLD.status='rejected' AND NEW.status='draft')) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='reviewers may only review draft proposals';
  END IF;
  IF current_user='dsh_service_runtime' AND NOT (OLD.status='approved' AND NEW.status='published') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='the review service may only publish approved proposals';
  END IF;
  IF TG_OP='UPDATE' AND current_user IN ('dsh_app_runtime','dsh_service_runtime')
    AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
      OR NEW.generation_run_id IS DISTINCT FROM OLD.generation_run_id
      OR NEW.target_type IS DISTINCT FROM OLD.target_type
      OR (NEW.target_id IS DISTINCT FROM OLD.target_id AND NOT
        (OLD.status='draft' AND OLD.operation='create' AND OLD.target_id IS NULL AND NEW.target_id IS NOT NULL))
      OR NEW.operation IS DISTINCT FROM OLD.operation OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
      OR NEW.base_version_no IS DISTINCT FROM OLD.base_version_no) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='reviewers cannot change proposal ownership or target';
  END IF;
    IF TG_OP='UPDATE' AND current_user='dsh_worker_runtime'
      AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
        OR NEW.generation_run_id IS DISTINCT FROM OLD.generation_run_id OR NEW.target_type IS DISTINCT FROM OLD.target_type
        OR NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.operation IS DISTINCT FROM OLD.operation
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.base_version_no IS DISTINCT FROM OLD.base_version_no
        OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.published_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='workers cannot change proposal ownership or review metadata';
  END IF;
  IF current_user='dsh_app_runtime' AND OLD.target_id IS NULL AND NEW.target_id IS NOT NULL
    AND (NEW.status <> 'draft' OR NEW.proposed_content IS DISTINCT FROM OLD.proposed_content
      OR NEW.validation_result IS DISTINCT FROM OLD.validation_result
      OR NEW.conflict_result IS DISTINCT FROM OLD.conflict_result) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='legacy proposal targets must be bound in a separate draft edit';
  END IF;
  IF current_user='dsh_app_runtime' AND (
    (NEW.status='draft' AND (NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
      OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.published_at IS NOT NULL))
    OR (OLD.status='rejected' AND NEW.status='draft'
      AND (NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.published_at IS NOT NULL))
    OR (NEW.status IN ('approved','rejected','expired')
      AND (NEW.reviewed_by_user_id IS DISTINCT FROM app.current_user_id()
        OR NEW.reviewed_at IS NULL OR NEW.published_at IS NOT NULL
        OR NEW.target_id IS NULL
        OR (OLD.target_id IS NULL AND NEW.target_id IS NOT NULL)
        OR NEW.proposed_content IS DISTINCT FROM OLD.proposed_content
        OR NEW.validation_result IS DISTINCT FROM OLD.validation_result
        OR NEW.conflict_result IS DISTINCT FROM OLD.conflict_result))) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='proposal review metadata must match the authenticated reviewer';
  END IF;
  IF current_user='dsh_service_runtime'
    AND (NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
      OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.published_at IS NULL
      OR NEW.proposed_content IS DISTINCT FROM OLD.proposed_content
      OR NEW.validation_result IS DISTINCT FROM OLD.validation_result
      OR NEW.conflict_result IS DISTINCT FROM OLD.conflict_result
      OR NEW.target_id IS DISTINCT FROM OLD.target_id) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='publication must preserve proposal review metadata';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER generation_proposals_guard_transition BEFORE INSERT OR UPDATE ON ai.generation_proposals
  FOR EACH ROW EXECUTE FUNCTION ai.guard_generation_proposal_transition();

CREATE OR REPLACE FUNCTION ai.audit_generation_proposal_change() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ai, security AS $$
DECLARE
  event_action TEXT;
  reviewer_id TEXT;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status IN ('approved','rejected','expired') THEN
    event_action := 'ai_proposal_' || NEW.status;
    reviewer_id := COALESCE(NEW.reviewed_by_user_id::TEXT, app.current_user_id()::TEXT);
  ELSIF NEW.status = 'published' THEN
    event_action := 'ai_proposal_published';
    reviewer_id := COALESCE(NEW.reviewed_by_user_id::TEXT, 'system');
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO security.audit_events(workspace_id, actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES (NEW.workspace_id, 'user', reviewer_id, event_action, NEW.target_type, NEW.target_id::TEXT,
    jsonb_build_object('proposal_id', NEW.id, 'generation_run_id', NEW.generation_run_id,
      'status', NEW.status));
  RETURN NEW;
END
$$;
CREATE TRIGGER generation_proposals_audit_change AFTER UPDATE OF status ON ai.generation_proposals
  FOR EACH ROW EXECUTE FUNCTION ai.audit_generation_proposal_change();

CREATE OR REPLACE FUNCTION ai.audit_generation_run_change() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ai, app, security AS $$
DECLARE
  event_action TEXT;
  event_actor_type TEXT;
  event_actor_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN RETURN NEW; END IF;
  event_action := CASE NEW.status
    WHEN 'queued' THEN 'ai_generation_run_queued'
    WHEN 'running' THEN 'ai_generation_run_started'
    WHEN 'completed' THEN 'ai_generation_run_completed'
    WHEN 'failed' THEN 'ai_generation_run_failed'
    WHEN 'cancelled' THEN 'ai_generation_run_cancelled'
  END;
  event_actor_type := COALESCE(NULLIF(app.current_actor_type(), ''),
    CASE WHEN app.current_database_role() = 'dsh_worker_runtime' THEN 'agent' ELSE 'user' END);
  event_actor_id := CASE event_actor_type
    WHEN 'agent' THEN COALESCE(app.current_agent_principal_id(), NEW.agent_principal_id)
    ELSE COALESCE(app.current_user_id()::TEXT, NEW.initiated_by_user_id::TEXT)
  END;
  INSERT INTO security.audit_events(workspace_id, actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES (NEW.workspace_id, event_actor_type, event_actor_id, event_action, 'generation_run', NEW.id::TEXT,
    jsonb_build_object('generation_run_id', NEW.id, 'status', NEW.status));
  RETURN NEW;
END
$$;
CREATE TRIGGER generation_runs_audit_insert AFTER INSERT ON ai.generation_runs
  FOR EACH ROW EXECUTE FUNCTION ai.audit_generation_run_change();
CREATE TRIGGER generation_runs_audit_update AFTER UPDATE OF status ON ai.generation_runs
  FOR EACH ROW EXECUTE FUNCTION ai.audit_generation_run_change();

DROP POLICY ai_runs_member_read ON ai.generation_runs;
CREATE POLICY ai_runs_member_read ON ai.generation_runs FOR SELECT TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY ai_runs_worker_read ON ai.generation_runs FOR SELECT TO dsh_worker_runtime
  USING (app.agent_run_allowed(workspace_id, novel_id, id));
CREATE POLICY ai_runs_worker_update ON ai.generation_runs FOR UPDATE TO dsh_worker_runtime
  USING (status IN ('queued','running') AND app.agent_run_allowed(workspace_id, novel_id, id))
  WITH CHECK (status IN ('running','completed','failed','cancelled') AND app.agent_run_allowed(workspace_id, novel_id, id));
DROP POLICY ai_runs_editor_create ON ai.generation_runs;
CREATE POLICY ai_runs_app_create ON ai.generation_runs FOR INSERT TO dsh_app_runtime
  WITH CHECK (status='queued' AND app.workspace_access_allowed(workspace_id, 'editor')
    AND initiated_by_user_id=app.current_user_id() AND novel_id IS NOT NULL AND source_session_id IS NOT NULL
    AND idempotency_key IS NOT NULL);
CREATE POLICY ai_runs_worker_create ON ai.generation_runs FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status='queued' AND workspace_id=app.current_workspace_id()
    AND initiated_by_user_id=app.current_user_id() AND agent_principal_id=app.current_agent_principal_id()
    AND novel_id IS NOT NULL AND source_session_id IS NOT NULL AND idempotency_key IS NOT NULL
    AND app.workspace_access_allowed(workspace_id, 'editor'));

DROP POLICY ai_proposals_member_read ON ai.generation_proposals;
CREATE POLICY ai_proposals_member_read ON ai.generation_proposals FOR SELECT TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
DROP POLICY ai_proposals_worker_draft_create ON ai.generation_proposals;
CREATE POLICY ai_proposals_worker_draft_create ON ai.generation_proposals FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status='draft' AND app.workspace_access_allowed(workspace_id, 'editor')
    AND app.agent_run_allowed(workspace_id, novel_id, generation_run_id));
CREATE POLICY ai_proposals_worker_read ON ai.generation_proposals FOR SELECT TO dsh_worker_runtime
  USING (app.agent_run_allowed(workspace_id, novel_id, generation_run_id));
DROP POLICY ai_proposals_worker_draft_update ON ai.generation_proposals;
CREATE POLICY ai_proposals_worker_draft_update ON ai.generation_proposals FOR UPDATE TO dsh_worker_runtime
  USING (status='draft' AND app.agent_run_allowed(workspace_id, novel_id, generation_run_id))
  WITH CHECK (status='draft' AND app.agent_run_allowed(workspace_id, novel_id, generation_run_id));
CREATE POLICY ai_proposals_service_read ON ai.generation_proposals FOR SELECT TO dsh_service_runtime
  USING (status='approved' AND app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY ai_proposals_service_publish ON ai.generation_proposals FOR UPDATE TO dsh_service_runtime
  USING (status='approved' AND app.workspace_access_allowed(workspace_id,'editor'))
  WITH CHECK (status='published' AND app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY ai_proposals_app_retry ON ai.generation_proposals FOR UPDATE TO dsh_app_runtime
  USING (status='rejected' AND app.workspace_access_allowed(workspace_id,'editor'))
  WITH CHECK (status='draft' AND app.workspace_access_allowed(workspace_id,'editor'));

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['character_versions','skill_versions','location_versions','faction_versions',
    'item_versions','storyline_versions','entity_relation_versions','character_skill_versions'] LOOP
    EXECUTE format('CREATE POLICY %I ON novel.%I FOR UPDATE TO dsh_app_runtime USING (status=''draft'' AND app.workspace_access_allowed(workspace_id,''editor'')) WITH CHECK (status=''draft'' AND app.workspace_access_allowed(workspace_id,''editor''))',
      table_name||'_editor_draft_update', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['characters','character_versions','skills','skill_versions','character_skills','character_skill_versions',
    'entity_relations','entity_relation_versions','locations','location_versions','factions','faction_versions',
    'items','item_versions','storylines','storyline_versions'] LOOP
    EXECUTE format('ALTER TABLE novel.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON novel.%I FOR INSERT TO dsh_worker_runtime WITH CHECK (status=''draft'' AND app.workspace_access_allowed(workspace_id,''editor'') AND app.agent_run_allowed(workspace_id,novel_id,source_generation_run_id))', table_name||'_worker_draft_insert', table_name);
    EXECUTE format('CREATE POLICY %I ON novel.%I FOR UPDATE TO dsh_worker_runtime USING (status=''draft'' AND app.workspace_access_allowed(workspace_id,''editor'') AND app.agent_run_allowed(workspace_id,novel_id,source_generation_run_id)) WITH CHECK (status=''draft'' AND app.workspace_access_allowed(workspace_id,''editor'') AND app.agent_run_allowed(workspace_id,novel_id,source_generation_run_id))', table_name||'_worker_draft_update', table_name);
  END LOOP;
END
$$;

CREATE POLICY locations_member_read ON novel.locations FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY locations_editor_write ON novel.locations FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id,'editor')) WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY factions_member_read ON novel.factions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY factions_editor_write ON novel.factions FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id,'editor')) WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY items_member_read ON novel.items FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY items_editor_write ON novel.items FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id,'editor')) WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY storylines_member_read ON novel.storylines FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY storylines_editor_write ON novel.storylines FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id,'editor')) WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY locations_versions_member_read ON novel.location_versions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY locations_versions_editor_write ON novel.location_versions FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY factions_versions_member_read ON novel.faction_versions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY factions_versions_editor_write ON novel.faction_versions FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY items_versions_member_read ON novel.item_versions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY items_versions_editor_write ON novel.item_versions FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY storylines_versions_member_read ON novel.storyline_versions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY storylines_versions_editor_write ON novel.storyline_versions FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY entity_relation_versions_member_read ON novel.entity_relation_versions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY entity_relation_versions_editor_write ON novel.entity_relation_versions FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));
CREATE POLICY character_skill_versions_member_read ON novel.character_skill_versions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id,'member'));
CREATE POLICY character_skill_versions_editor_write ON novel.character_skill_versions FOR INSERT TO dsh_app_runtime
  WITH CHECK (app.workspace_access_allowed(workspace_id,'editor'));

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['locations','factions','items','storylines','location_versions',
    'faction_versions','item_versions','storyline_versions','entity_relation_versions','character_skill_versions'] LOOP
    EXECUTE format('CREATE POLICY %I ON novel.%I FOR SELECT TO dsh_readonly USING (app.workspace_access_allowed(workspace_id,''member''))',
      table_name||'_readonly_read', table_name);
  END LOOP;
END
$$;
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['characters','character_versions','skills','skill_versions','character_skills','character_skill_versions',
    'entity_relations','entity_relation_versions','locations','location_versions','factions','faction_versions',
    'items','item_versions','storylines','storyline_versions'] LOOP
    EXECUTE format('CREATE POLICY %I ON novel.%I FOR SELECT TO dsh_service_runtime USING (app.workspace_access_allowed(workspace_id,''editor''))', table_name||'_service_read', table_name);
    IF table_name IN ('character_versions','skill_versions','location_versions','faction_versions','item_versions','storyline_versions','entity_relation_versions','character_skill_versions') THEN
      EXECUTE format('CREATE POLICY %I ON novel.%I FOR UPDATE TO dsh_service_runtime USING (status=''draft'' AND app.workspace_access_allowed(workspace_id,''editor'')) WITH CHECK (status=''published'' AND app.workspace_access_allowed(workspace_id,''editor''))', table_name||'_service_publish', table_name);
    ELSE
      EXECUTE format('CREATE POLICY %I ON novel.%I FOR UPDATE TO dsh_service_runtime USING (status IN (''draft'',''published'') AND app.workspace_access_allowed(workspace_id,''editor'')) WITH CHECK (status=''published'' AND app.workspace_access_allowed(workspace_id,''editor''))', table_name||'_service_publish', table_name);
    END IF;
  END LOOP;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA auth,app,novel,ai,security FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id(),app.current_service_bypass(),app.current_workspace_id(),
  app.current_actor_type(),app.current_agent_principal_id(),app.current_database_role(),
  app.workspace_access_allowed(UUID,TEXT),app.workspace_owner_is_current_user(UUID)
  TO dsh_auth_runtime,dsh_app_runtime,dsh_worker_runtime,dsh_readonly,dsh_service_runtime;
GRANT EXECUTE ON FUNCTION app.transfer_workspace_owner(UUID,UUID) TO dsh_app_runtime;
GRANT EXECUTE ON FUNCTION app.agent_run_allowed(UUID,UUID,UUID) TO dsh_worker_runtime;
GRANT EXECUTE ON FUNCTION novel.entity_payload_matches(TEXT,JSONB,JSONB) TO dsh_service_runtime;
GRANT EXECUTE ON FUNCTION novel.approved_version_exists(TEXT,UUID,UUID,UUID,INTEGER,UUID,TEXT) TO dsh_service_runtime;
GRANT SELECT,INSERT,UPDATE ON novel.characters,novel.skills,novel.locations,novel.factions,novel.items,
  novel.storylines,novel.entity_relations,novel.character_skills TO dsh_worker_runtime;
GRANT SELECT,INSERT ON novel.character_versions,novel.skill_versions,novel.location_versions,novel.faction_versions,
  novel.item_versions,novel.storyline_versions,novel.entity_relation_versions,novel.character_skill_versions TO dsh_worker_runtime;
GRANT UPDATE ON novel.character_versions,novel.skill_versions,novel.location_versions,novel.faction_versions,
  novel.item_versions,novel.storyline_versions,novel.entity_relation_versions,novel.character_skill_versions TO dsh_worker_runtime;
GRANT INSERT ON novel.location_versions,novel.faction_versions,novel.item_versions,
  novel.storyline_versions,novel.entity_relation_versions,novel.character_skill_versions TO dsh_app_runtime;
GRANT UPDATE ON novel.location_versions,novel.faction_versions,novel.item_versions,
  novel.storyline_versions,novel.entity_relation_versions,novel.character_skill_versions TO dsh_app_runtime;
GRANT SELECT,INSERT,UPDATE ON novel.locations, novel.factions, novel.items, novel.storylines TO dsh_app_runtime;
GRANT SELECT,INSERT ON novel.location_versions, novel.faction_versions, novel.item_versions,
  novel.storyline_versions, novel.entity_relation_versions TO dsh_app_runtime;
GRANT SELECT ON novel.locations, novel.factions, novel.items, novel.storylines, novel.location_versions,
  novel.faction_versions, novel.item_versions, novel.storyline_versions, novel.entity_relation_versions,
  novel.character_skill_versions
  TO dsh_readonly;
GRANT SELECT ON novel.character_skill_versions TO dsh_app_runtime,dsh_worker_runtime,dsh_service_runtime;
GRANT SELECT,UPDATE ON novel.characters,novel.skills,novel.locations,novel.factions,novel.items,
  novel.storylines,novel.entity_relations,novel.character_skills TO dsh_service_runtime;
GRANT SELECT,UPDATE ON novel.character_versions,novel.skill_versions,novel.location_versions,
  novel.faction_versions,novel.item_versions,novel.storyline_versions,novel.entity_relation_versions,
  novel.character_skill_versions TO dsh_service_runtime;
GRANT SELECT,UPDATE ON ai.generation_proposals TO dsh_service_runtime;
GRANT UPDATE ON ai.generation_proposals TO dsh_app_runtime;
GRANT INSERT ON security.audit_events TO dsh_service_runtime;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth,app,novel,ai,security TO dsh_migrator;
REVOKE CREATE ON SCHEMA auth,app,novel,ai,security
  FROM dsh_auth_runtime,dsh_app_runtime,dsh_worker_runtime,dsh_readonly,dsh_service_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA auth,app,novel,ai,security FROM PUBLIC;
