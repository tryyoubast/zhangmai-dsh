-- Harden long-form records added by 0004. This migration is additive: the
-- already-applied 0001-0004 files remain immutable.

ALTER TABLE novel.chapter_summaries
  ADD COLUMN status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN source_idempotency_key TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE novel.chapter_summaries
  ADD CONSTRAINT chapter_summaries_status_check
    CHECK (status IN ('draft', 'published', 'archived', 'deleted'));
CREATE UNIQUE INDEX chapter_summaries_workspace_idempotency_idx
  ON novel.chapter_summaries(workspace_id, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION novel.entity_reference_exists(
  requested_type TEXT,
  requested_id UUID,
  requested_workspace_id UUID,
  requested_novel_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, novel
AS $$
BEGIN
  CASE requested_type
    WHEN 'characters' THEN RETURN EXISTS (SELECT 1 FROM novel.characters WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'skills' THEN RETURN EXISTS (SELECT 1 FROM novel.skills WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'locations' THEN RETURN EXISTS (SELECT 1 FROM novel.locations WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'factions' THEN RETURN EXISTS (SELECT 1 FROM novel.factions WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'items' THEN RETURN EXISTS (SELECT 1 FROM novel.items WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'storylines' THEN RETURN EXISTS (SELECT 1 FROM novel.storylines WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'entity_relations' THEN RETURN EXISTS (SELECT 1 FROM novel.entity_relations WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'character_skills' THEN RETURN EXISTS (SELECT 1 FROM novel.character_skills WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'outlines' THEN RETURN EXISTS (SELECT 1 FROM novel.outlines WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'chapters' THEN RETURN EXISTS (SELECT 1 FROM novel.chapters WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'chapter_versions' THEN RETURN EXISTS (SELECT 1 FROM novel.chapter_versions WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'chapter_summaries' THEN RETURN EXISTS (SELECT 1 FROM novel.chapter_summaries WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'story_facts' THEN RETURN EXISTS (SELECT 1 FROM novel.story_facts WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    WHEN 'timeline_events' THEN RETURN EXISTS (SELECT 1 FROM novel.timeline_events WHERE id = requested_id AND workspace_id = requested_workspace_id AND novel_id = requested_novel_id);
    ELSE RETURN FALSE;
  END CASE;
END
$$;

CREATE OR REPLACE FUNCTION novel.entity_payload_matches(
  requested_type TEXT,
  row_content JSONB,
  proposed_content JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE requested_type
    WHEN 'character_skills' THEN proposed_content = jsonb_build_object(
      'character_id', row_content->'character_id', 'skill_id', row_content->'skill_id',
      'relation_type', row_content->'relation_type', 'source_version_no', row_content->'source_version_no',
      'attributes_jsonb', row_content->'attributes_jsonb',
      'attributes_schema_version', row_content->'attributes_schema_version')
    ELSE requested_type IN (
      'characters', 'skills', 'locations', 'factions', 'items', 'storylines',
      'entity_relations', 'outlines', 'chapters', 'chapter_versions',
      'chapter_summaries', 'story_facts', 'timeline_events'
    ) AND proposed_content = row_content - ARRAY[
      'id', 'workspace_id', 'novel_id', 'status', 'current_version_no',
      'created_by_user_id', 'source_generation_run_id', 'source_idempotency_key',
      'created_at', 'updated_at', 'deleted_at'
    ]
  END
$$;

CREATE OR REPLACE FUNCTION novel.guard_longform_publication()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  approved_proposal RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND current_user NOT IN ('dsh_migrator', 'dsh_service_runtime') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'new long-form records must be drafts';
    END IF;
    IF current_user = 'dsh_worker_runtime'
      AND (NEW.status <> 'draft' OR NEW.source_generation_run_id IS NULL
        OR NEW.source_idempotency_key IS NULL
        OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
        OR NOT app.agent_run_allowed(NEW.workspace_id, NEW.novel_id, NEW.source_generation_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'AI workers may only create their own draft records';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.source_generation_run_id IS DISTINCT FROM OLD.source_generation_run_id
    OR NEW.source_idempotency_key IS DISTINCT FROM OLD.source_idempotency_key THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'long-form record ownership is immutable';
  END IF;

  IF current_user = 'dsh_worker_runtime'
    AND (OLD.status <> 'draft' OR NEW.status <> 'draft'
      OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
      OR NEW.source_generation_run_id IS NULL
      OR NOT app.agent_run_allowed(NEW.workspace_id, NEW.novel_id, NEW.source_generation_run_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'AI workers may only edit their own draft records';
  END IF;

  IF NEW.status = 'published' AND current_user <> 'dsh_service_runtime' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'publishing long-form records requires the review service';
  END IF;

  IF current_user = 'dsh_service_runtime' THEN
    SELECT proposal.* INTO approved_proposal
    FROM ai.generation_proposals AS proposal
    WHERE proposal.workspace_id = OLD.workspace_id
      AND proposal.novel_id = OLD.novel_id
      AND proposal.target_type = TG_TABLE_NAME
      AND proposal.target_id = OLD.id
      AND proposal.status = 'approved'
      AND proposal.reviewed_by_user_id IS NOT NULL
      AND proposal.reviewed_at IS NOT NULL
      AND proposal.published_at IS NULL
      AND proposal.proposed_content = to_jsonb(OLD) - ARRAY[
        'id', 'workspace_id', 'novel_id', 'status', 'current_version_no',
        'created_by_user_id', 'source_generation_run_id', 'source_idempotency_key',
        'created_at', 'updated_at', 'deleted_at'
      ]
      AND proposal.base_version_no IS NOT DISTINCT FROM
        CASE
          WHEN (to_jsonb(OLD)->>'status') = 'draft' THEN NULL::INTEGER
          ELSE (to_jsonb(OLD)->>'current_version_no')::INTEGER
        END
    ORDER BY proposal.reviewed_at DESC
    LIMIT 1;
    IF OLD.status <> 'draft' OR NEW.status <> 'published' OR NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'long-form publication requires an approved matching proposal';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'outlines', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON novel.%I FOR EACH ROW EXECUTE FUNCTION novel.guard_longform_publication()',
      table_name || '_guard_publication', table_name
    );
  END LOOP;
END
$$;

DROP POLICY novel_chapter_summaries_worker_draft_insert ON novel.chapter_summaries;
CREATE POLICY novel_chapter_summaries_worker_draft_insert ON novel.chapter_summaries
  FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_chapter_summaries_worker_draft_update ON novel.chapter_summaries
  FOR UPDATE TO dsh_worker_runtime
  USING (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id))
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_chapter_summaries_service_publish ON novel.chapter_summaries
  FOR UPDATE TO dsh_service_runtime
  USING (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (status = 'published' AND app.workspace_access_allowed(workspace_id, 'editor'));

GRANT SELECT, UPDATE ON novel.chapter_summaries TO dsh_worker_runtime;
GRANT SELECT, UPDATE ON novel.chapter_summaries TO dsh_service_runtime;
REVOKE EXECUTE ON FUNCTION novel.entity_reference_exists(TEXT, UUID, UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION novel.entity_payload_matches(TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION novel.guard_longform_publication() FROM PUBLIC;
