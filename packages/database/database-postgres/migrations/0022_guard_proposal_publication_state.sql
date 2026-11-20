-- Published proposal status and its audit must agree with the persisted target.
CREATE FUNCTION ai.require_published_proposal_target() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, ai, novel, app AS $$
DECLARE entity JSONB; expected_version INTEGER;
BEGIN
  IF current_user <> 'dsh_service_runtime' OR NEW.status <> 'published' THEN RETURN NEW; END IF;

  IF OLD.status <> 'approved' OR OLD.target_id IS NULL
    OR app.current_actor_type() IS DISTINCT FROM 'user'
    OR app.current_workspace_id() IS DISTINCT FROM OLD.workspace_id
    OR OLD.reviewed_by_user_id IS NULL OR OLD.reviewed_by_user_id IS DISTINCT FROM app.current_user_id()
    OR current_setting('app.publication_proposal_id', true) IS DISTINCT FROM OLD.id::TEXT
    OR OLD.target_type NOT IN ('characters','skills','locations','factions','items','storylines',
      'entity_relations','character_skills','outlines','chapters','chapter_versions','chapter_summaries','story_facts','timeline_events')
  THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='proposal publication requires its authenticated reviewer and target';
  END IF;

  EXECUTE format('SELECT to_jsonb(target) FROM novel.%I target WHERE workspace_id=$1 AND novel_id=$2 AND id=$3', OLD.target_type)
    INTO entity USING OLD.workspace_id, OLD.novel_id, OLD.target_id;
  IF entity->>'status' IS DISTINCT FROM 'published'
    OR novel.entity_payload_matches(OLD.target_type, entity, OLD.proposed_content) IS DISTINCT FROM TRUE
  THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='the approved target must be published first';
  END IF;

  IF novel.proposal_version_storage(OLD.target_type) IS NOT NULL THEN
    expected_version := CASE WHEN OLD.operation = 'update' THEN OLD.base_version_no + 1 ELSE 1 END;
    IF (entity->>'current_version_no')::INTEGER IS DISTINCT FROM expected_version
      OR NOT novel.approved_version_exists(OLD.target_type, OLD.target_id, OLD.workspace_id,
        OLD.novel_id, expected_version, OLD.id, 'published')
    THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='the exact approved candidate must be published first';
    END IF;
  ELSIF OLD.operation <> 'create' OR OLD.base_version_no IS NOT NULL OR EXISTS (
    SELECT 1 FROM ai.generation_proposals AS proposal WHERE proposal.workspace_id = OLD.workspace_id
      AND proposal.novel_id = OLD.novel_id AND proposal.target_type = OLD.target_type
      AND proposal.target_id = OLD.target_id AND proposal.status = 'published'
  ) THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='only one create proposal may publish a long-form target';
  END IF;

  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ai.require_published_proposal_target() FROM PUBLIC;
CREATE TRIGGER generation_proposals_require_published_target
  BEFORE UPDATE OF status ON ai.generation_proposals
  FOR EACH ROW EXECUTE FUNCTION ai.require_published_proposal_target();
