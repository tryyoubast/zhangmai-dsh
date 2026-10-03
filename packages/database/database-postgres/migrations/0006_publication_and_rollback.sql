-- Database-owned publication and rollback transactions.
-- AI workers never receive EXECUTE on either function.

CREATE OR REPLACE FUNCTION ai.publish_generation_proposal(
  requested_workspace_id UUID,
  requested_proposal_id UUID
)
RETURNS TABLE(target_type TEXT, target_id UUID)
LANGUAGE plpgsql
SET search_path = pg_catalog, ai, novel, app, security
AS $$
DECLARE
  proposal RECORD;
  target_table TEXT;
  current_status TEXT;
  current_version INTEGER;
  updated_count INTEGER;
BEGIN
  IF current_user <> 'dsh_service_runtime'
    OR app.current_actor_type() <> 'user'
    OR app.current_workspace_id() IS DISTINCT FROM requested_workspace_id
    OR app.current_user_id() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'publication requires a trusted service user context';
  END IF;

  SELECT * INTO proposal
  FROM ai.generation_proposals
  WHERE id = requested_proposal_id AND workspace_id = requested_workspace_id
  FOR UPDATE;
  IF NOT FOUND OR proposal.status <> 'approved'
    OR proposal.target_id IS NULL
    OR proposal.reviewed_by_user_id IS DISTINCT FROM app.current_user_id()
    OR proposal.reviewed_at IS NULL
    OR proposal.published_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'proposal is not approved for publication';
  END IF;

  target_table := CASE proposal.target_type
    WHEN 'outlines' THEN 'outlines'
    WHEN 'characters' THEN 'characters'
    WHEN 'skills' THEN 'skills'
    WHEN 'locations' THEN 'locations'
    WHEN 'factions' THEN 'factions'
    WHEN 'items' THEN 'items'
    WHEN 'storylines' THEN 'storylines'
    WHEN 'entity_relations' THEN 'entity_relations'
    WHEN 'character_skills' THEN 'character_skills'
    WHEN 'chapters' THEN 'chapters'
    WHEN 'chapter_versions' THEN 'chapter_versions'
    WHEN 'chapter_summaries' THEN 'chapter_summaries'
    WHEN 'story_facts' THEN 'story_facts'
    WHEN 'timeline_events' THEN 'timeline_events'
    ELSE NULL
  END;
  IF target_table IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported publication target type';
  END IF;

  EXECUTE format(
    'SELECT status, current_version_no FROM novel.%I WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    target_table
  ) INTO current_status, current_version USING requested_workspace_id, proposal.target_id;
  IF NOT FOUND OR current_status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'publication target is missing or no longer a draft';
  END IF;
  IF proposal.operation = 'update' AND proposal.base_version_no IS DISTINCT FROM current_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'publication target version conflict';
  END IF;
  IF proposal.operation IN ('create', 'link') AND proposal.base_version_no IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'new publication cannot carry a base version';
  END IF;

  EXECUTE format(
    'UPDATE novel.%I SET status = ''published'', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = ''draft''',
    target_table
  ) USING requested_workspace_id, proposal.target_id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'publication target changed concurrently';
  END IF;

  UPDATE ai.generation_proposals
  SET status = 'published', published_at = statement_timestamp()
  WHERE id = requested_proposal_id AND workspace_id = requested_workspace_id AND status = 'approved';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'proposal changed concurrently';
  END IF;

  INSERT INTO security.audit_events(
    workspace_id, actor_type, actor_id, action, target_type, target_id, metadata
  ) VALUES (
    requested_workspace_id, 'user', app.current_user_id()::TEXT, 'ai_proposal_published',
    proposal.target_type, proposal.target_id::TEXT,
    jsonb_build_object('proposal_id', requested_proposal_id, 'generation_run_id', proposal.generation_run_id)
  );
  RETURN QUERY SELECT proposal.target_type, proposal.target_id;
END
$$;

CREATE OR REPLACE FUNCTION ai.rollback_entity_version(
  requested_workspace_id UUID,
  requested_target_type TEXT,
  requested_target_id UUID,
  requested_version_no INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ai, novel, app, security
AS $$
DECLARE
  version_table TEXT;
  parent_column TEXT;
  content JSONB;
  current_version INTEGER;
  target_exists BOOLEAN;
BEGIN
  IF NOT pg_has_role(session_user, 'dsh_service_runtime', 'member')
    OR app.current_actor_type() <> 'user'
    OR app.current_workspace_id() IS DISTINCT FROM requested_workspace_id
    OR app.current_user_id() IS NULL
    OR requested_version_no < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'rollback requires a trusted service user context';
  END IF;

  version_table := CASE requested_target_type
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
  parent_column := CASE requested_target_type
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
  IF version_table IS NULL OR parent_column IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported rollback target type';
  END IF;

  EXECUTE format(
    'SELECT content_jsonb FROM novel.%I WHERE workspace_id = $1 AND %I = $2 AND version_no = $3 AND status IN (''draft'', ''published'') FOR UPDATE',
    version_table, parent_column
  ) INTO content USING requested_workspace_id, requested_target_id, requested_version_no;
  IF content IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'requested version does not exist';
  END IF;

  EXECUTE format(
    'SELECT current_version_no FROM novel.%I WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    CASE requested_target_type
      WHEN 'characters' THEN 'characters'
      WHEN 'skills' THEN 'skills'
      WHEN 'locations' THEN 'locations'
      WHEN 'factions' THEN 'factions'
      WHEN 'items' THEN 'items'
      WHEN 'storylines' THEN 'storylines'
      WHEN 'entity_relations' THEN 'entity_relations'
      ELSE 'character_skills'
    END
  ) INTO current_version USING requested_workspace_id, requested_target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'rollback target does not exist';
  END IF;

  CASE requested_target_type
    WHEN 'characters', 'skills', 'locations', 'factions', 'items', 'storylines' THEN
      EXECUTE format(
        'UPDATE novel.%I SET name = COALESCE($3->>''name'', name), summary = $3->>''summary'', attributes_jsonb = COALESCE($3->''attributes_jsonb'', ''{}''::jsonb), attributes_schema_version = COALESCE(($3->>''attributes_schema_version'')::integer, attributes_schema_version), current_version_no = $4, status = ''published'', updated_at = now() WHERE workspace_id = $1 AND id = $2',
        CASE requested_target_type
          WHEN 'characters' THEN 'characters' WHEN 'skills' THEN 'skills' WHEN 'locations' THEN 'locations'
          WHEN 'factions' THEN 'factions' WHEN 'items' THEN 'items' ELSE 'storylines'
        END
      ) USING requested_workspace_id, requested_target_id, content, requested_version_no;
    WHEN 'entity_relations' THEN
      EXECUTE 'UPDATE novel.entity_relations SET relation_type = COALESCE($3->>''relation_type'', relation_type), status = ''published'', attributes_jsonb = COALESCE($3->''attributes_jsonb'', ''{}''::jsonb), attributes_schema_version = COALESCE(($3->>''attributes_schema_version'')::integer, attributes_schema_version), current_version_no = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2'
      USING requested_workspace_id, requested_target_id, content, requested_version_no;
    WHEN 'character_skills' THEN
      EXECUTE 'UPDATE novel.character_skills SET relation_type = COALESCE($3->>''relation_type'', relation_type), status = ''published'', attributes_jsonb = COALESCE($3->''attributes_jsonb'', ''{}''::jsonb), attributes_schema_version = COALESCE(($3->>''attributes_schema_version'')::integer, attributes_schema_version), current_version_no = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2'
      USING requested_workspace_id, requested_target_id, content, requested_version_no;
  END CASE;

  INSERT INTO security.audit_events(
    workspace_id, actor_type, actor_id, action, target_type, target_id, metadata
  ) VALUES (
    requested_workspace_id, 'user', app.current_user_id()::TEXT, 'novel_entity_rolled_back',
    requested_target_type, requested_target_id::TEXT,
    jsonb_build_object('version_no', requested_version_no, 'previous_version_no', current_version)
  );
END
$$;

REVOKE EXECUTE ON FUNCTION ai.publish_generation_proposal(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ai.rollback_entity_version(UUID, TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.publish_generation_proposal(UUID, UUID) TO dsh_service_runtime;
GRANT EXECUTE ON FUNCTION ai.rollback_entity_version(UUID, TEXT, UUID, INTEGER) TO dsh_service_runtime;
