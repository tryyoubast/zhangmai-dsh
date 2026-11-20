-- Proposal identity, rather than generation run/content equality, owns each candidate.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- SELECT must retain visibility of the post-update published row under RLS.
ALTER POLICY ai_proposals_service_read ON ai.generation_proposals
  USING(status IN ('approved','published') AND app.workspace_access_allowed(workspace_id,'editor'));
ALTER TABLE novel.character_versions DROP CONSTRAINT character_versions_character_id_version_no_key;
ALTER TABLE novel.skill_versions DROP CONSTRAINT skill_versions_skill_id_version_no_key;
ALTER TABLE novel.location_versions DROP CONSTRAINT location_versions_workspace_id_location_id_version_no_key;
ALTER TABLE novel.faction_versions DROP CONSTRAINT faction_versions_workspace_id_location_id_version_no_key;
ALTER TABLE novel.item_versions DROP CONSTRAINT item_versions_workspace_id_location_id_version_no_key;
ALTER TABLE novel.storyline_versions DROP CONSTRAINT storyline_versions_workspace_id_location_id_version_no_key;
ALTER TABLE novel.entity_relation_versions DROP CONSTRAINT entity_relation_versions_workspace_id_relation_id_version_n_key;
ALTER TABLE novel.character_skill_versions DROP CONSTRAINT character_skill_versions_workspace_entity_version_key;

CREATE FUNCTION novel.proposal_version_storage(requested_type TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT CASE requested_type
    WHEN 'characters' THEN ARRAY['character_versions','character_id']
    WHEN 'skills' THEN ARRAY['skill_versions','skill_id']
    WHEN 'locations' THEN ARRAY['location_versions','location_id']
    WHEN 'factions' THEN ARRAY['faction_versions','faction_id']
    WHEN 'items' THEN ARRAY['item_versions','item_id']
    WHEN 'storylines' THEN ARRAY['storyline_versions','storyline_id']
    WHEN 'entity_relations' THEN ARRAY['entity_relation_versions','relation_id']
    WHEN 'character_skills' THEN ARRAY['character_skill_versions','character_skill_id'] END
$$;
REVOKE ALL ON FUNCTION novel.proposal_version_storage(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.proposal_version_storage(TEXT) TO dsh_app_runtime,dsh_worker_runtime,dsh_service_runtime;

DO $$
DECLARE entity_type TEXT; storage TEXT[];
BEGIN
  FOREACH entity_type IN ARRAY ARRAY['characters','skills','locations','factions','items','storylines','entity_relations','character_skills'] LOOP
    storage := novel.proposal_version_storage(entity_type);
    EXECUTE format('CREATE UNIQUE INDEX %I ON novel.%I(workspace_id,%I,version_no) WHERE status<>''draft''', storage[1]||'_history_no_idx',storage[1],storage[2]);
    EXECUTE format('CREATE UNIQUE INDEX %I ON novel.%I(workspace_id,source_id) WHERE source_type=''generation_proposal''',storage[1]||'_proposal_idx',storage[1]);
    EXECUTE format('ALTER TABLE novel.%I ADD CONSTRAINT %I CHECK(source_type<>''generation_proposal'' OR source_id IS NOT NULL)',storage[1],storage[1]||'_proposal_source_check');
  END LOOP;
  FOREACH entity_type IN ARRAY ARRAY['outlines','chapters','chapter_versions','chapter_summaries','story_facts','timeline_events'] LOOP
    EXECUTE format('CREATE POLICY %I ON novel.%I FOR SELECT TO dsh_service_runtime USING(app.workspace_access_allowed(workspace_id,''editor''))',entity_type||'_service_read',entity_type);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION novel.approved_version_exists(
  requested_type TEXT, requested_target_id UUID, requested_workspace_id UUID,
  requested_novel_id UUID, requested_version_no INTEGER, requested_proposal_id UUID,
  requested_version_status TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, novel, ai, app AS $$
DECLARE storage TEXT[] := novel.proposal_version_storage(requested_type); result BOOLEAN;
BEGIN
  IF storage IS NULL THEN RETURN FALSE; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM novel.%I v JOIN ai.generation_proposals p ON p.id=$1 AND p.workspace_id=v.workspace_id
    JOIN ai.generation_runs r ON r.id=p.generation_run_id AND r.workspace_id=p.workspace_id AND r.novel_id=p.novel_id
    WHERE v.%I=$2 AND v.workspace_id=$3 AND v.novel_id=$4 AND v.version_no=$5 AND v.status=$7
      AND v.source_type=''generation_proposal'' AND v.source_id=p.id
      AND v.source_idempotency_key=''proposal:''||p.id::text
      AND v.source_generation_run_id=p.generation_run_id AND v.created_by_user_id=r.initiated_by_user_id
      AND p.target_type=$6 AND p.target_id=$2 AND p.novel_id=$4 AND p.status=''approved''
      AND p.reviewed_by_user_id=app.current_user_id() AND p.reviewed_at IS NOT NULL AND p.published_at IS NULL
      AND p.proposed_content=v.content_jsonb
      AND ((p.operation IN (''create'',''link'') AND p.base_version_no IS NULL AND v.version_no=1)
        OR (p.operation=''update'' AND p.base_version_no=v.version_no-1)))',storage[1],storage[2])
    INTO result USING requested_proposal_id,requested_target_id,requested_workspace_id,requested_novel_id,requested_version_no,requested_type,requested_version_status;
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION novel.guard_version_publication() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, novel, ai, app AS $$
DECLARE entity_type TEXT; storage TEXT[]; parent_id UUID; p RECORD; creator UUID; entity_version INTEGER; historical JSONB;
BEGIN
  entity_type := CASE TG_TABLE_NAME WHEN 'character_versions' THEN 'characters' WHEN 'skill_versions' THEN 'skills'
    WHEN 'location_versions' THEN 'locations' WHEN 'faction_versions' THEN 'factions' WHEN 'item_versions' THEN 'items'
    WHEN 'storyline_versions' THEN 'storylines' WHEN 'entity_relation_versions' THEN 'entity_relations'
    WHEN 'character_skill_versions' THEN 'character_skills' END;
  storage := novel.proposal_version_storage(entity_type);
  parent_id := (to_jsonb(NEW)->>storage[2])::UUID;
  IF current_user='dsh_migrator' THEN RETURN NEW; END IF;
  IF novel.rollback_context_active() THEN
    entity_version := NULL;
    EXECUTE format('SELECT current_version_no FROM novel.%I WHERE workspace_id=$1 AND novel_id=$2 AND id=$3',entity_type)
      INTO entity_version USING NEW.workspace_id,NEW.novel_id,parent_id;
    EXECUTE format('SELECT content_jsonb FROM novel.%I WHERE workspace_id=$1 AND novel_id=$2 AND %I=$3 AND version_no=$4 AND status=''published''',storage[1],storage[2])
      INTO historical USING NEW.workspace_id,NEW.novel_id,parent_id,NULLIF(current_setting('app.rollback_source_version_no',true),'')::INTEGER;
    IF TG_OP<>'INSERT' OR current_setting('app.rollback_workspace_id',true) IS DISTINCT FROM NEW.workspace_id::TEXT
      OR current_setting('app.rollback_target_id',true) IS DISTINCT FROM parent_id::TEXT
      OR current_setting('app.rollback_target_type',true) IS DISTINCT FROM entity_type
      OR entity_version IS NULL OR NEW.version_no IS DISTINCT FROM entity_version+1 OR NEW.status<>'published'
      OR NEW.source_type<>'rollback' OR NEW.source_id IS NOT NULL OR NEW.source_generation_run_id IS NOT NULL
      OR NEW.source_idempotency_key IS NOT NULL OR historical IS NULL OR NEW.content_jsonb IS DISTINCT FROM historical
      OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='invalid rollback version insertion';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.source_type='generation_proposal' OR NEW.source_type='generation_proposal') THEN
    IF to_jsonb(NEW)-ARRAY['content_jsonb','status'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['content_jsonb','status'] THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='candidate identity and provenance are immutable';
    END IF;
  END IF;
  IF NEW.source_type='generation_proposal' THEN
    SELECT proposal.* INTO p
      FROM ai.generation_proposals proposal
      WHERE proposal.workspace_id=NEW.workspace_id AND proposal.novel_id=NEW.novel_id AND proposal.id=NEW.source_id;
    IF NOT FOUND OR p.target_type IS DISTINCT FROM entity_type OR p.target_id IS DISTINCT FROM parent_id
      OR NEW.source_generation_run_id IS DISTINCT FROM p.generation_run_id
      OR NEW.source_idempotency_key IS DISTINCT FROM 'proposal:'||p.id::TEXT
      OR NEW.version_no IS DISTINCT FROM (CASE WHEN p.operation='update' THEN p.base_version_no+1 ELSE 1 END)
      OR NEW.content_jsonb IS DISTINCT FROM p.proposed_content THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='candidate must match its own persisted proposal';
    END IF;
    IF TG_OP='INSERT' OR (OLD.status='draft' AND NEW.status='draft') THEN
      IF current_user NOT IN ('dsh_app_runtime','dsh_worker_runtime') OR pg_trigger_depth()<2 OR p.status<>'draft' THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='candidate content is synchronized only from its own draft proposal';
      END IF;
      SELECT initiated_by_user_id INTO creator FROM ai.generation_runs
        WHERE workspace_id=NEW.workspace_id AND novel_id=NEW.novel_id AND id=p.generation_run_id;
      IF creator IS NULL OR NEW.created_by_user_id IS DISTINCT FROM creator THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='candidate creator must be its persisted run initiator';
      END IF;
      RETURN NEW;
    END IF;
    IF current_user='dsh_service_runtime' AND OLD.status='draft' AND NEW.status='published'
      AND OLD.content_jsonb=NEW.content_jsonb
      AND novel.approved_version_exists(entity_type,parent_id,NEW.workspace_id,NEW.novel_id,NEW.version_no,NEW.source_id,'draft') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='publishing a version requires its exact approved proposal';
  END IF;
  IF TG_OP='INSERT' THEN
    IF current_user='dsh_service_runtime' OR NEW.status<>'draft' THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='the review service must publish an existing candidate';
    END IF;
    IF current_user='dsh_worker_runtime' AND (NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
      OR NEW.source_idempotency_key IS NULL OR NEW.source_generation_run_id IS NULL
      OR NOT app.agent_run_allowed(NEW.workspace_id,NEW.novel_id,NEW.source_generation_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='workers may only create their own draft versions';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user NOT IN ('dsh_app_runtime','dsh_worker_runtime') OR OLD.status<>'draft' OR NEW.status<>'draft'
    OR to_jsonb(NEW)-'content_jsonb' IS DISTINCT FROM to_jsonb(OLD)-'content_jsonb' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='legacy versions cannot be published as proposal candidates';
  END IF;
  IF current_user='dsh_worker_runtime' AND (NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
    OR NOT app.agent_run_allowed(NEW.workspace_id,NEW.novel_id,NEW.source_generation_run_id)) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='workers may only edit their own draft versions';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION novel.guard_draft_publication() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, novel, ai, app AS $$
DECLARE p RECORD; is_version BOOLEAN := TG_TABLE_NAME IN ('character_versions','skill_versions','location_versions','faction_versions','item_versions','storyline_versions','entity_relation_versions','character_skill_versions');
BEGIN
  -- Every version table has the stricter version trigger, including character_skill_versions.
  IF is_version THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' AND current_user<>'dsh_migrator' THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='new novel records must be drafts';
    END IF;
    IF current_user='dsh_worker_runtime' AND (NEW.source_idempotency_key IS NULL
      OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.source_generation_run_id IS NULL
      OR NOT app.agent_run_allowed(NEW.workspace_id,NEW.novel_id,NEW.source_generation_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='workers must provide their own run and idempotency key';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.novel_id IS DISTINCT FROM OLD.novel_id OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.source_generation_run_id IS DISTINCT FROM OLD.source_generation_run_id
    OR NEW.source_idempotency_key IS DISTINCT FROM OLD.source_idempotency_key THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='novel record ownership is immutable';
  END IF;
  IF TG_TABLE_NAME='character_skills' AND (to_jsonb(NEW)->'character_id' IS DISTINCT FROM to_jsonb(OLD)->'character_id'
    OR to_jsonb(NEW)->'skill_id' IS DISTINCT FROM to_jsonb(OLD)->'skill_id') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='character skill endpoints are immutable; create a new link';
  END IF;
  IF current_user='dsh_migrator' THEN RETURN NEW; END IF;
  IF novel.rollback_context_active() THEN
    IF current_setting('app.rollback_workspace_id',true) IS DISTINCT FROM NEW.workspace_id::TEXT
      OR current_setting('app.rollback_target_id',true) IS DISTINCT FROM NEW.id::TEXT
      OR current_setting('app.rollback_target_type',true) IS DISTINCT FROM TG_TABLE_NAME
      OR OLD.status<>'published' OR NEW.status<>'published' OR NEW.current_version_no IS DISTINCT FROM OLD.current_version_no+1 THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='invalid rollback entity transition';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user='dsh_worker_runtime' AND (OLD.status<>'draft' OR NEW.status<>'draft'
    OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.source_generation_run_id IS NULL
    OR NOT app.agent_run_allowed(NEW.workspace_id,NEW.novel_id,NEW.source_generation_run_id)) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='workers may only edit their own drafts';
  END IF;
  IF current_user='dsh_service_runtime' THEN
    SELECT proposal.* INTO p FROM ai.generation_proposals proposal
      WHERE proposal.workspace_id=OLD.workspace_id AND proposal.novel_id=OLD.novel_id AND proposal.target_type=TG_TABLE_NAME
        AND proposal.target_id=OLD.id AND proposal.id=NULLIF(current_setting('app.publication_proposal_id',true),'')::UUID
        AND proposal.status='approved' AND proposal.reviewed_by_user_id=app.current_user_id()
        AND proposal.reviewed_at IS NOT NULL AND proposal.published_at IS NULL;
    IF NOT FOUND OR NEW.status<>'published'
      OR NOT ((OLD.status='draft' AND p.operation IN ('create','link') AND p.base_version_no IS NULL AND NEW.current_version_no=1)
        OR (OLD.status='published' AND p.operation='update' AND p.base_version_no=OLD.current_version_no AND NEW.current_version_no=OLD.current_version_no+1))
      OR NOT novel.approved_version_exists(TG_TABLE_NAME,NEW.id,NEW.workspace_id,NEW.novel_id,NEW.current_version_no,p.id,'published')
      OR NOT novel.entity_payload_matches(TG_TABLE_NAME,to_jsonb(NEW),p.proposed_content) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='entity publication requires its exact approved candidate';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status='published' AND OLD.status<>'published' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='publishing requires the review service';
  END IF;
  IF NEW.current_version_no IS DISTINCT FROM OLD.current_version_no THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='version numbers advance only during reviewed publication';
  END IF;
  IF current_user='dsh_app_runtime' THEN
    IF OLD.status='published' AND NEW.status NOT IN ('published','archived','deleted') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='published records cannot return to draft';
    END IF;
    IF (OLD.status='published' OR NEW.status IN ('archived','deleted'))
      AND to_jsonb(NEW)-ARRAY['status','updated_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','updated_at'] THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='published content requires a reviewed version';
    END IF;
    IF OLD.status='draft' AND NEW.status='draft' AND to_jsonb(NEW)-'updated_at' IS DISTINCT FROM to_jsonb(OLD)-'updated_at'
      AND NOT EXISTS(SELECT 1 FROM ai.generation_proposals proposal WHERE proposal.workspace_id=OLD.workspace_id
        AND proposal.novel_id=OLD.novel_id AND proposal.target_type=TG_TABLE_NAME AND proposal.target_id=OLD.id
        AND proposal.operation IN ('create','link') AND proposal.status='draft') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='draft edits require an existing draft proposal';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION ai.sync_generation_proposal_candidate() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, ai, novel AS $$
DECLARE storage TEXT[] := novel.proposal_version_storage(NEW.target_type); creator UUID; existing UUID; candidate RECORD;
BEGIN
  IF storage IS NULL OR NEW.target_id IS NULL OR NEW.status='published' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id AND NEW.proposed_content IS NOT DISTINCT FROM OLD.proposed_content THEN RETURN NEW; END IF;
  SELECT initiated_by_user_id INTO creator FROM ai.generation_runs
    WHERE workspace_id=NEW.workspace_id AND novel_id=NEW.novel_id AND id=NEW.generation_run_id;
  IF creator IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='candidate requires its visible persisted generation run'; END IF;
  EXECUTE format('SELECT id FROM novel.%I WHERE workspace_id=$1 AND source_type=''generation_proposal'' AND source_id=$2',storage[1])
    INTO existing USING NEW.workspace_id,NEW.id;
  IF existing IS NULL THEN
    EXECUTE format('INSERT INTO novel.%I(workspace_id,novel_id,%I,version_no,status,content_jsonb,source_type,source_id,source_generation_run_id,source_idempotency_key,created_by_user_id)
      VALUES($1,$2,$3,$4,''draft'',$5,''generation_proposal'',$6,$7,$8,$9)',storage[1],storage[2])
      USING NEW.workspace_id,NEW.novel_id,NEW.target_id,CASE WHEN NEW.operation='update' THEN NEW.base_version_no+1 ELSE 1 END,
        NEW.proposed_content,NEW.id,NEW.generation_run_id,'proposal:'||NEW.id::TEXT,creator;
  ELSE
    EXECUTE format('UPDATE novel.%I SET content_jsonb=$3 WHERE workspace_id=$1 AND id=$2',storage[1])
      USING NEW.workspace_id,existing,NEW.proposed_content;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ai.sync_generation_proposal_candidate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.sync_generation_proposal_candidate() TO dsh_app_runtime,dsh_worker_runtime;
CREATE TRIGGER generation_proposals_sync_candidate AFTER INSERT OR UPDATE OF target_id,proposed_content ON ai.generation_proposals
  FOR EACH ROW EXECUTE FUNCTION ai.sync_generation_proposal_candidate();

-- Existing legacy rows remain untouched. A colliding reserved key needs explicit repair.
DO $$
DECLARE p RECORD; storage TEXT[]; collision TEXT; creator UUID;
BEGIN
  FOR p IN SELECT * FROM ai.generation_proposals WHERE target_id IS NOT NULL AND status IN ('draft','approved','rejected','expired') ORDER BY id LOOP
    storage:=novel.proposal_version_storage(p.target_type);
    IF storage IS NULL THEN CONTINUE; END IF;
    collision:=NULL;
    EXECUTE format('SELECT string_agg(id::text,'','') FROM novel.%I WHERE workspace_id=$1 AND
      ((source_type=''generation_proposal'' AND source_id=$2) OR source_idempotency_key=$3)',storage[1])
      INTO collision USING p.workspace_id,p.id,'proposal:'||p.id::TEXT;
    IF collision IS NOT NULL THEN RAISE EXCEPTION '0020 candidate collision: proposal %, version IDs %',p.id,collision; END IF;
    SELECT initiated_by_user_id INTO creator FROM ai.generation_runs WHERE workspace_id=p.workspace_id AND novel_id=p.novel_id AND id=p.generation_run_id;
    IF creator IS NULL THEN RAISE EXCEPTION '0020 candidate source run missing: proposal %, run %',p.id,p.generation_run_id; END IF;
    EXECUTE format('INSERT INTO novel.%I(workspace_id,novel_id,%I,version_no,status,content_jsonb,source_type,source_id,source_generation_run_id,source_idempotency_key,created_by_user_id)
      VALUES($1,$2,$3,$4,''draft'',$5,''generation_proposal'',$6,$7,$8,$9)',storage[1],storage[2])
      USING p.workspace_id,p.novel_id,p.target_id,CASE WHEN p.operation='update' THEN p.base_version_no+1 ELSE 1 END,p.proposed_content,p.id,p.generation_run_id,'proposal:'||p.id::TEXT,creator;
  END LOOP;
END
$$;

-- Only semantic fields are projected; ownership and generation provenance stay on the entity.
CREATE FUNCTION novel.apply_entity_version_content(requested_type TEXT,requested_workspace UUID,requested_novel UUID,requested_id UUID,content JSONB,next_version INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, novel AS $$
DECLARE columns TEXT[]; assignments TEXT; changed INTEGER;
BEGIN
  CASE requested_type
    WHEN 'characters','skills','locations','factions','items','storylines' THEN columns:=ARRAY['name','summary','attributes_jsonb','attributes_schema_version'];
    WHEN 'entity_relations' THEN columns:=ARRAY['source_entity_type','source_entity_id','target_entity_type','target_entity_id','relation_type','strength','attributes_jsonb','attributes_schema_version','source_version_no','valid_from','valid_to'];
    WHEN 'character_skills' THEN columns:=ARRAY['relation_type','source_version_no','attributes_jsonb','attributes_schema_version'];
    ELSE RAISE EXCEPTION USING ERRCODE='P2004',MESSAGE='unsupported entity projection';
  END CASE;
  SELECT string_agg(format('%I=x.%I',col,col),',') INTO assignments FROM unnest(columns) col;
  EXECUTE format('UPDATE novel.%I t SET %s,current_version_no=$5,status=''published'',updated_at=statement_timestamp()
    FROM jsonb_populate_record(NULL::novel.%I,$4) x WHERE t.workspace_id=$1 AND t.novel_id=$2 AND t.id=$3',requested_type,assignments,requested_type)
    USING requested_workspace,requested_novel,requested_id,content,next_version;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='entity changed concurrently'; END IF;
END
$$;
REVOKE ALL ON FUNCTION novel.apply_entity_version_content(TEXT,UUID,UUID,UUID,JSONB,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.apply_entity_version_content(TEXT,UUID,UUID,UUID,JSONB,INTEGER) TO dsh_service_runtime;

CREATE OR REPLACE FUNCTION novel.guard_longform_publication() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, novel, ai, app AS $$
DECLARE p RECORD;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' AND current_user<>'dsh_migrator' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='new long-form records must be drafts'; END IF;
    IF current_user='dsh_worker_runtime' AND (NEW.source_generation_run_id IS NULL OR NEW.source_idempotency_key IS NULL
      OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NOT app.agent_run_allowed(NEW.workspace_id,NEW.novel_id,NEW.source_generation_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='workers may only create their own long-form drafts';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.source_generation_run_id IS DISTINCT FROM OLD.source_generation_run_id
    OR NEW.source_idempotency_key IS DISTINCT FROM OLD.source_idempotency_key THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='long-form record ownership is immutable';
  END IF;
  IF current_user='dsh_migrator' THEN RETURN NEW; END IF;
  IF current_user='dsh_worker_runtime' AND (OLD.status<>'draft' OR NEW.status<>'draft'
    OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.source_generation_run_id IS NULL
    OR NOT app.agent_run_allowed(NEW.workspace_id,NEW.novel_id,NEW.source_generation_run_id)) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='workers may only edit their own long-form drafts';
  END IF;
  IF current_user='dsh_service_runtime' THEN
    SELECT * INTO p FROM ai.generation_proposals proposal WHERE proposal.workspace_id=OLD.workspace_id AND proposal.novel_id=OLD.novel_id
      AND proposal.id=NULLIF(current_setting('app.publication_proposal_id',true),'')::UUID
      AND proposal.target_type=TG_TABLE_NAME AND proposal.target_id=OLD.id AND proposal.status='approved'
      AND proposal.reviewed_by_user_id=app.current_user_id() AND proposal.reviewed_at IS NOT NULL AND proposal.published_at IS NULL
      AND proposal.operation='create' AND proposal.base_version_no IS NULL;
    IF NOT FOUND OR OLD.status<>'draft' OR NEW.status<>'published'
      OR to_jsonb(NEW)-ARRAY['status','updated_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','updated_at']
      OR NOT novel.entity_payload_matches(TG_TABLE_NAME,to_jsonb(NEW),p.proposed_content) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='long-form publication requires its exact approved create proposal';
    END IF;
  ELSE
    IF NEW.status='published' THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='long-form publication requires the review service';
    END IF;
    IF current_user='dsh_app_runtime' AND OLD.status<>'draft' THEN
      IF NEW.status NOT IN ('archived','deleted')
        OR to_jsonb(NEW)-ARRAY['status','updated_at','deleted_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','updated_at','deleted_at'] THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='published long-form content is immutable and cannot return to draft';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION ai.publish_generation_proposal(requested_workspace_id UUID,requested_proposal_id UUID)
RETURNS TABLE(target_type TEXT,target_id UUID) LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, ai, novel, app AS $$
DECLARE locator RECORD; p RECORD; entity JSONB; candidate RECORD; storage TEXT[]; next_version INTEGER; changed INTEGER;
BEGIN
  IF current_user<>'dsh_service_runtime' OR app.current_actor_type()<>'user' OR app.current_user_id() IS NULL
    OR app.current_workspace_id() IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='publication requires a trusted service user context';
  END IF;
  SELECT proposal.target_type,proposal.target_id,proposal.novel_id,proposal.operation,proposal.base_version_no INTO locator FROM ai.generation_proposals proposal
    WHERE proposal.workspace_id=requested_workspace_id AND proposal.id=requested_proposal_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='publication target not found'; END IF;
  IF locator.target_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='proposal target is not bound'; END IF;
  IF locator.target_type NOT IN ('characters','skills','locations','factions','items','storylines','entity_relations','character_skills','outlines','chapters','chapter_versions','chapter_summaries','story_facts','timeline_events') THEN
    RAISE EXCEPTION USING ERRCODE='P2004',MESSAGE='unsupported publication target';
  END IF;
  IF novel.proposal_version_storage(locator.target_type) IS NULL AND (locator.operation<>'create' OR locator.base_version_no IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='P2004',MESSAGE='long-form publication supports only initial creation';
  END IF;
  entity:=NULL;
  EXECUTE format('SELECT to_jsonb(t) FROM novel.%I t WHERE workspace_id=$1 AND novel_id=$2 AND id=$3 FOR NO KEY UPDATE',locator.target_type)
    INTO entity USING requested_workspace_id,locator.novel_id,locator.target_id;
  IF entity IS NULL THEN
    -- Draft-only long-form UPDATE policies can hide a winner after a lock wait.
    EXECUTE format('SELECT to_jsonb(t) FROM novel.%I t WHERE workspace_id=$1 AND novel_id=$2 AND id=$3',locator.target_type)
      INTO entity USING requested_workspace_id,locator.novel_id,locator.target_id;
    IF entity IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='publication target is no longer editable'; END IF;
    RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='publication target not found';
  END IF;
  SELECT * INTO p FROM ai.generation_proposals proposal WHERE proposal.workspace_id=requested_workspace_id AND proposal.id=requested_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='publication target not found'; END IF;
  IF p.target_id IS DISTINCT FROM locator.target_id OR p.target_type IS DISTINCT FROM locator.target_type OR p.novel_id IS DISTINCT FROM locator.novel_id
    OR p.status<>'approved' OR p.published_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='proposal is no longer approved for publication';
  END IF;
  IF p.reviewed_by_user_id IS DISTINCT FROM app.current_user_id() OR p.reviewed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='publication requires its authenticated reviewer';
  END IF;
  storage:=novel.proposal_version_storage(p.target_type);
  IF storage IS NULL THEN
    IF p.operation<>'create' OR p.base_version_no IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P2004',MESSAGE='long-form publication supports only initial creation'; END IF;
    IF entity->>'status'<>'draft' THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='long-form target is no longer a draft'; END IF;
    IF NOT novel.entity_payload_matches(p.target_type,entity,p.proposed_content) THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='long-form target content changed'; END IF;
    PERFORM set_config('app.publication_proposal_id',p.id::TEXT,true);
    -- chapter_versions deliberately has neither current_version_no nor updated_at.
    EXECUTE format('UPDATE novel.%I SET status=''published''%s WHERE workspace_id=$1 AND novel_id=$2 AND id=$3',p.target_type,
      CASE WHEN p.target_type='chapter_versions' THEN '' ELSE ',updated_at=statement_timestamp()' END)
      USING requested_workspace_id,p.novel_id,p.target_id;
  ELSE
    IF NOT ((p.operation IN ('create','link') AND p.base_version_no IS NULL AND entity->>'status'='draft' AND (entity->>'current_version_no')::INTEGER=1)
      OR (p.operation='update' AND entity->>'status'='published' AND p.base_version_no=(entity->>'current_version_no')::INTEGER)) THEN
      RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='publication target version conflict';
    END IF;
    next_version:=CASE WHEN p.operation='update' THEN p.base_version_no+1 ELSE 1 END;
    EXECUTE format('SELECT * FROM novel.%I WHERE workspace_id=$1 AND novel_id=$2 AND %I=$3 AND source_type=''generation_proposal'' AND source_id=$4 FOR UPDATE',storage[1],storage[2])
      INTO candidate USING requested_workspace_id,p.novel_id,p.target_id,p.id;
    IF candidate.id IS NULL OR NOT novel.approved_version_exists(p.target_type,p.target_id,p.workspace_id,p.novel_id,next_version,p.id,'draft') THEN
      RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='exact proposal candidate is missing or changed';
    END IF;
    PERFORM set_config('app.publication_proposal_id',p.id::TEXT,true);
    EXECUTE format('UPDATE novel.%I SET status=''published'' WHERE workspace_id=$1 AND id=$2',storage[1]) USING requested_workspace_id,candidate.id;
    PERFORM novel.apply_entity_version_content(p.target_type,p.workspace_id,p.novel_id,p.target_id,p.proposed_content,next_version);
  END IF;
  UPDATE ai.generation_proposals SET status='published',published_at=statement_timestamp() WHERE workspace_id=requested_workspace_id AND id=p.id AND status='approved';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='proposal changed concurrently'; END IF;
  PERFORM set_config('app.publication_proposal_id','',true);
  RETURN QUERY SELECT p.target_type::TEXT,p.target_id::UUID;
END
$$;

CREATE OR REPLACE FUNCTION ai.rollback_entity_version(requested_workspace_id UUID,requested_target_type TEXT,requested_target_id UUID,requested_version_no INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, ai, novel, app, security AS $$
DECLARE storage TEXT[]; entity JSONB; content JSONB; next_version INTEGER;
BEGIN
  IF current_user<>'dsh_service_runtime' OR app.current_actor_type()<>'user' OR app.current_user_id() IS NULL
    OR app.current_workspace_id() IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='rollback requires a trusted service user context';
  END IF;
  storage:=novel.proposal_version_storage(requested_target_type);
  IF storage IS NULL OR requested_version_no IS NULL OR requested_version_no<1 THEN RAISE EXCEPTION USING ERRCODE='P2004',MESSAGE='invalid rollback arguments'; END IF;
  entity:=NULL;
  EXECUTE format('SELECT to_jsonb(t) FROM novel.%I t WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE',requested_target_type)
    INTO entity USING requested_workspace_id,requested_target_id;
  IF entity IS NULL THEN RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='rollback target not found'; END IF;
  IF entity->>'status'<>'published' OR requested_version_no>=(entity->>'current_version_no')::INTEGER THEN
    RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='rollback requires an older published version';
  END IF;
  content:=NULL;
  EXECUTE format('SELECT content_jsonb FROM novel.%I WHERE workspace_id=$1 AND novel_id=$2 AND %I=$3 AND version_no=$4 AND status=''published''',storage[1],storage[2])
    INTO content USING requested_workspace_id,(entity->>'novel_id')::UUID,requested_target_id,requested_version_no;
  IF content IS NULL THEN RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='rollback version not found'; END IF;
  IF requested_target_type='character_skills' AND (content->'character_id' IS DISTINCT FROM entity->'character_id' OR content->'skill_id' IS DISTINCT FROM entity->'skill_id') THEN
    RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='historical character skill endpoints do not match this link';
  END IF;
  next_version:=(entity->>'current_version_no')::INTEGER+1;
  PERFORM set_config('app.rollback_context','1',true),set_config('app.rollback_workspace_id',requested_workspace_id::TEXT,true),
    set_config('app.rollback_target_type',requested_target_type,true),set_config('app.rollback_target_id',requested_target_id::TEXT,true),
    set_config('app.rollback_source_version_no',requested_version_no::TEXT,true);
  EXECUTE format('INSERT INTO novel.%I(workspace_id,novel_id,%I,version_no,status,content_jsonb,source_type,source_id,created_by_user_id)
    VALUES($1,$2,$3,$4,''published'',$5,''rollback'',NULL,$6)',storage[1],storage[2])
    USING requested_workspace_id,(entity->>'novel_id')::UUID,requested_target_id,next_version,content,app.current_user_id();
  PERFORM novel.apply_entity_version_content(requested_target_type,requested_workspace_id,(entity->>'novel_id')::UUID,requested_target_id,content,next_version);
  PERFORM set_config('app.rollback_context','',true),set_config('app.rollback_workspace_id','',true),
    set_config('app.rollback_target_type','',true),set_config('app.rollback_target_id','',true),set_config('app.rollback_source_version_no','',true);
  INSERT INTO security.audit_events(workspace_id,actor_type,actor_id,action,target_type,target_id,metadata)
    VALUES(requested_workspace_id,'user',app.current_user_id()::TEXT,'novel_entity_rolled_back',requested_target_type,requested_target_id::TEXT,
      jsonb_build_object('version_no',next_version,'source_version_no',requested_version_no,'previous_version_no',(entity->>'current_version_no')::INTEGER));
END
$$;

REVOKE ALL ON FUNCTION novel.guard_draft_publication(),novel.guard_version_publication(),novel.guard_longform_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION ai.publish_generation_proposal(UUID,UUID),ai.rollback_entity_version(UUID,TEXT,UUID,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.publish_generation_proposal(UUID,UUID),ai.rollback_entity_version(UUID,TEXT,UUID,INTEGER) TO dsh_service_runtime;
CREATE OR REPLACE FUNCTION ai.guard_generation_proposal_transition() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, ai, app AS $$
BEGIN
  IF TG_OP='UPDATE' AND current_user<>'dsh_migrator' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='proposal identity is immutable';
  END IF;
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
    (OLD.status<>'rejected' AND NEW.status='draft' AND (NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
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
