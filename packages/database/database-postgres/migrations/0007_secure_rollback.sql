-- Rollback creates a new published version instead of rewinding the version
-- counter. The narrow transaction-local context is accepted only by triggers.

CREATE OR REPLACE FUNCTION novel.rollback_context_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, app
AS $$
  SELECT current_user = 'dsh_service_runtime'
    AND app.current_actor_type() = 'user'
    AND app.current_user_id() IS NOT NULL
    AND current_setting('app.rollback_context', true) = '1'
$$;

CREATE OR REPLACE FUNCTION novel.guard_draft_publication() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF novel.rollback_context_active() THEN
    IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN (
      'character_versions', 'skill_versions', 'location_versions', 'faction_versions',
      'item_versions', 'storyline_versions', 'entity_relation_versions', 'character_skill_versions'
    ) THEN
      RETURN NEW;
    END IF;
    IF TG_OP <> 'UPDATE' OR TG_TABLE_NAME NOT IN (
      'characters', 'skills', 'locations', 'factions', 'items', 'storylines',
      'entity_relations', 'character_skills'
    ) OR current_setting('app.rollback_workspace_id', true) IS DISTINCT FROM NEW.workspace_id::TEXT
      OR current_setting('app.rollback_target_id', true) IS DISTINCT FROM NEW.id::TEXT
      OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR OLD.novel_id IS DISTINCT FROM NEW.novel_id
      OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
      OR OLD.status NOT IN ('draft', 'published') OR NEW.status <> 'published'
      OR NEW.current_version_no IS DISTINCT FROM OLD.current_version_no + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'invalid rollback entity transition';
    END IF;
    RETURN NEW;
  END IF;

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
      OR NEW.source_idempotency_key IS NULL OR NEW.source_generation_run_id IS NULL
      OR NOT app.agent_run_allowed(NEW.workspace_id, NEW.novel_id, NEW.source_generation_run_id)) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers may only write their own draft records';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.source_generation_run_id IS DISTINCT FROM OLD.source_generation_run_id
    OR NEW.source_idempotency_key IS DISTINCT FROM OLD.source_idempotency_key THEN
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
      DECLARE approved_proposal RECORD;
      BEGIN
        SELECT proposal.* INTO approved_proposal FROM ai.generation_proposals proposal
        WHERE proposal.workspace_id=OLD.workspace_id AND proposal.novel_id=OLD.novel_id
          AND proposal.target_type=TG_TABLE_NAME AND proposal.target_id=OLD.id AND proposal.status='approved'
          AND proposal.reviewed_by_user_id IS NOT NULL AND proposal.reviewed_at IS NOT NULL
          AND proposal.published_at IS NULL
          AND ((OLD.status='draft' AND proposal.operation=CASE WHEN TG_TABLE_NAME='character_skills' THEN 'link' ELSE 'create' END
              AND proposal.base_version_no IS NULL AND NEW.current_version_no=OLD.current_version_no)
            OR (OLD.status='published' AND proposal.operation='update'
              AND proposal.base_version_no=OLD.current_version_no AND NEW.current_version_no=OLD.current_version_no+1));
        IF NOT FOUND OR NEW.status <> 'published'
          OR (OLD.status='draft' AND NEW.current_version_no IS DISTINCT FROM OLD.current_version_no)
          OR (OLD.status='published' AND NEW.current_version_no IS DISTINCT FROM OLD.current_version_no+1)
          OR NOT novel.approved_version_exists(TG_TABLE_NAME, OLD.id, OLD.workspace_id, OLD.novel_id,
            NEW.current_version_no, approved_proposal.id, 'published')
          OR NOT novel.entity_payload_matches(TG_TABLE_NAME, to_jsonb(NEW), approved_proposal.proposed_content) THEN
          RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='publishing a novel record requires its approved proposal and matching base version';
        END IF;
      END;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION novel.guard_version_publication() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  publication_target_type TEXT;
  publication_target_id UUID;
  approved_proposal RECORD;
  entity_version INTEGER;
BEGIN
  IF novel.rollback_context_active() THEN
    publication_target_type := CASE TG_TABLE_NAME
      WHEN 'character_versions' THEN 'characters' WHEN 'skill_versions' THEN 'skills'
      WHEN 'location_versions' THEN 'locations' WHEN 'faction_versions' THEN 'factions'
      WHEN 'item_versions' THEN 'items' WHEN 'storyline_versions' THEN 'storylines'
      WHEN 'entity_relation_versions' THEN 'entity_relations'
      WHEN 'character_skill_versions' THEN 'character_skills' END;
    publication_target_id := CASE TG_TABLE_NAME
      WHEN 'character_versions' THEN NEW.character_id WHEN 'skill_versions' THEN NEW.skill_id
      WHEN 'location_versions' THEN NEW.location_id WHEN 'faction_versions' THEN NEW.faction_id
      WHEN 'item_versions' THEN NEW.item_id WHEN 'storyline_versions' THEN NEW.storyline_id
      WHEN 'entity_relation_versions' THEN NEW.relation_id
      WHEN 'character_skill_versions' THEN NEW.character_skill_id END;
    EXECUTE format('SELECT current_version_no FROM novel.%I WHERE workspace_id=$1 AND id=$2', publication_target_type)
      INTO entity_version USING NEW.workspace_id, publication_target_id;
    IF TG_OP <> 'INSERT' OR publication_target_type IS NULL
      OR current_setting('app.rollback_workspace_id', true) IS DISTINCT FROM NEW.workspace_id::TEXT
      OR current_setting('app.rollback_target_id', true) IS DISTINCT FROM publication_target_id::TEXT
      OR current_setting('app.rollback_target_type', true) IS DISTINCT FROM publication_target_type
      OR NEW.version_no IS DISTINCT FROM entity_version + 1 OR NEW.status <> 'published'
      OR NEW.source_type <> 'rollback' OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'invalid rollback version insertion';
    END IF;
    RETURN NEW;
  END IF;

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
      WHEN 'character_skill_versions' THEN 'character_skills' WHEN 'character_versions' THEN 'characters'
      WHEN 'skill_versions' THEN 'skills' WHEN 'location_versions' THEN 'locations'
      WHEN 'faction_versions' THEN 'factions' WHEN 'item_versions' THEN 'items'
      WHEN 'storyline_versions' THEN 'storylines' WHEN 'entity_relation_versions' THEN 'entity_relations' END;
    publication_target_id := CASE TG_TABLE_NAME
      WHEN 'character_skill_versions' THEN NEW.character_skill_id WHEN 'character_versions' THEN NEW.character_id
      WHEN 'skill_versions' THEN NEW.skill_id WHEN 'location_versions' THEN NEW.location_id
      WHEN 'faction_versions' THEN NEW.faction_id WHEN 'item_versions' THEN NEW.item_id
      WHEN 'storyline_versions' THEN NEW.storyline_id WHEN 'entity_relation_versions' THEN NEW.relation_id END;
    SELECT proposal.* INTO approved_proposal FROM ai.generation_proposals proposal
    WHERE proposal.workspace_id=NEW.workspace_id AND proposal.novel_id=NEW.novel_id
      AND proposal.target_type=publication_target_type AND proposal.target_id=publication_target_id
      AND proposal.status='approved' AND proposal.reviewed_by_user_id IS NOT NULL AND proposal.reviewed_at IS NOT NULL
      AND proposal.published_at IS NULL AND proposal.proposed_content=OLD.content_jsonb
      AND ((proposal.operation IN ('create','link') AND proposal.base_version_no IS NULL AND OLD.version_no=1)
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
DECLARE version_table TEXT;
BEGIN
  FOREACH version_table IN ARRAY ARRAY[
    'character_versions','skill_versions','location_versions','faction_versions','item_versions',
    'storyline_versions','entity_relation_versions','character_skill_versions'
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON novel.%I FOR INSERT TO dsh_service_runtime WITH CHECK (app.workspace_access_allowed(workspace_id, ''editor''))',
      version_table || '_service_rollback_insert', version_table);
  END LOOP;
END
$$;
GRANT INSERT ON novel.character_versions, novel.skill_versions, novel.location_versions, novel.faction_versions,
  novel.item_versions, novel.storyline_versions, novel.entity_relation_versions, novel.character_skill_versions
  TO dsh_service_runtime;

CREATE OR REPLACE FUNCTION ai.rollback_entity_version(
  requested_workspace_id UUID,
  requested_target_type TEXT,
  requested_target_id UUID,
  requested_version_no INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, ai, novel, app, security
AS $$
DECLARE
  target_table TEXT;
  version_table TEXT;
  parent_column TEXT;
  current_version INTEGER;
  next_version INTEGER;
  target_novel_id UUID;
  content JSONB;
  changed_count INTEGER;
BEGIN
  IF current_user <> 'dsh_service_runtime'
    OR app.current_actor_type() <> 'user'
    OR app.current_workspace_id() IS DISTINCT FROM requested_workspace_id
    OR app.current_user_id() IS NULL
    OR requested_version_no < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'rollback requires a trusted service user context';
  END IF;

  target_table := CASE requested_target_type
    WHEN 'characters' THEN 'characters' WHEN 'skills' THEN 'skills' WHEN 'locations' THEN 'locations'
    WHEN 'factions' THEN 'factions' WHEN 'items' THEN 'items' WHEN 'storylines' THEN 'storylines'
    WHEN 'entity_relations' THEN 'entity_relations' WHEN 'character_skills' THEN 'character_skills' END;
  version_table := CASE requested_target_type
    WHEN 'characters' THEN 'character_versions' WHEN 'skills' THEN 'skill_versions'
    WHEN 'locations' THEN 'location_versions' WHEN 'factions' THEN 'faction_versions'
    WHEN 'items' THEN 'item_versions' WHEN 'storylines' THEN 'storyline_versions'
    WHEN 'entity_relations' THEN 'entity_relation_versions'
    WHEN 'character_skills' THEN 'character_skill_versions' END;
  parent_column := CASE requested_target_type
    WHEN 'characters' THEN 'character_id' WHEN 'skills' THEN 'skill_id' WHEN 'locations' THEN 'location_id'
    WHEN 'factions' THEN 'faction_id' WHEN 'items' THEN 'item_id' WHEN 'storylines' THEN 'storyline_id'
    WHEN 'entity_relations' THEN 'relation_id' WHEN 'character_skills' THEN 'character_skill_id' END;
  IF target_table IS NULL OR version_table IS NULL OR parent_column IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported rollback target type';
  END IF;

  EXECUTE format('SELECT current_version_no, novel_id FROM novel.%I WHERE workspace_id=$1 AND id=$2 FOR UPDATE', target_table)
    INTO current_version, target_novel_id USING requested_workspace_id, requested_target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'rollback target does not exist';
  END IF;
  IF requested_version_no >= current_version THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'rollback must target an older version';
  END IF;
  EXECUTE format('SELECT content_jsonb FROM novel.%I WHERE workspace_id=$1 AND %I=$2 AND version_no=$3 AND status=''published''', version_table, parent_column)
    INTO content USING requested_workspace_id, requested_target_id, requested_version_no;
  IF NOT FOUND OR content IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'requested published version does not exist';
  END IF;
  next_version := current_version + 1;

  PERFORM set_config('app.rollback_context', '1', true);
  PERFORM set_config('app.rollback_workspace_id', requested_workspace_id::TEXT, true);
  PERFORM set_config('app.rollback_target_type', requested_target_type, true);
  PERFORM set_config('app.rollback_target_id', requested_target_id::TEXT, true);
  EXECUTE format('INSERT INTO novel.%I(workspace_id, novel_id, %I, version_no, status, content_jsonb, source_type, source_id, created_by_user_id) VALUES ($1,$2,$3,$4,''published'',$5,''rollback'',NULL,$6)', version_table, parent_column)
    USING requested_workspace_id, target_novel_id, requested_target_id, next_version, content, app.current_user_id();

  CASE requested_target_type
    WHEN 'characters','skills','locations','factions','items','storylines' THEN
      EXECUTE format('UPDATE novel.%I SET name=COALESCE($3->>''name'',name), summary=$3->>''summary'', attributes_jsonb=COALESCE($3->''attributes_jsonb'',''{}''::jsonb), attributes_schema_version=COALESCE(($3->>''attributes_schema_version'')::integer,attributes_schema_version), current_version_no=$4, status=''published'', updated_at=now() WHERE workspace_id=$1 AND id=$2', target_table)
        USING requested_workspace_id, requested_target_id, content, next_version;
    WHEN 'entity_relations' THEN
      UPDATE novel.entity_relations SET relation_type=COALESCE(content->>'relation_type',relation_type),
        attributes_jsonb=COALESCE(content->'attributes_jsonb','{}'::jsonb),
        attributes_schema_version=COALESCE((content->>'attributes_schema_version')::INTEGER,attributes_schema_version),
        current_version_no=next_version,status='published',updated_at=now()
        WHERE workspace_id=requested_workspace_id AND id=requested_target_id;
    WHEN 'character_skills' THEN
      UPDATE novel.character_skills SET relation_type=COALESCE(content->>'relation_type',relation_type),
        source_version_no=(content->>'source_version_no')::INTEGER,
        attributes_jsonb=COALESCE(content->'attributes_jsonb','{}'::jsonb),
        attributes_schema_version=COALESCE((content->>'attributes_schema_version')::INTEGER,attributes_schema_version),
        current_version_no=next_version,status='published',updated_at=now()
        WHERE workspace_id=requested_workspace_id AND id=requested_target_id;
  END CASE;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'rollback target changed concurrently';
  END IF;
  PERFORM set_config('app.rollback_context', '', true);
  PERFORM set_config('app.rollback_workspace_id', '', true);
  PERFORM set_config('app.rollback_target_type', '', true);
  PERFORM set_config('app.rollback_target_id', '', true);

  INSERT INTO security.audit_events(workspace_id, actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES (requested_workspace_id, 'user', app.current_user_id()::TEXT, 'novel_entity_rolled_back',
    requested_target_type, requested_target_id::TEXT,
    jsonb_build_object('version_no', next_version, 'source_version_no', requested_version_no,
      'previous_version_no', current_version));
END
$$;

REVOKE EXECUTE ON FUNCTION novel.rollback_context_active() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ai.rollback_entity_version(UUID, TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.rollback_context_active() TO dsh_service_runtime;
GRANT EXECUTE ON FUNCTION ai.rollback_entity_version(UUID, TEXT, UUID, INTEGER) TO dsh_service_runtime;
