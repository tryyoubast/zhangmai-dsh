-- Long-form novel persistence. AI writes records in these fixed tables; it never receives DDL privileges.
ALTER TABLE ai.generation_proposals DROP CONSTRAINT IF EXISTS generation_proposals_target_type_check;
ALTER TABLE ai.generation_proposals ADD CONSTRAINT generation_proposals_target_type_check CHECK (
  target_type IN ('outlines', 'characters', 'skills', 'locations', 'factions', 'items', 'storylines',
    'entity_relations', 'character_skills', 'chapters', 'chapter_versions', 'chapter_summaries',
    'story_facts', 'timeline_events')
);

CREATE TABLE novel.outlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  title TEXT NOT NULL,
  content_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  current_version_no INTEGER NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT outlines_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT outlines_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id)
    REFERENCES novel.novels(workspace_id, id),
  CONSTRAINT outlines_created_by_user_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES auth.users(id),
  CONSTRAINT outlines_generation_run_fkey FOREIGN KEY (workspace_id, novel_id, source_generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT outlines_status_check CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  CONSTRAINT outlines_version_check CHECK (current_version_no > 0)
);
CREATE UNIQUE INDEX outlines_workspace_idempotency_idx
  ON novel.outlines(workspace_id, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;
CREATE INDEX outlines_workspace_novel_status_idx
  ON novel.outlines(workspace_id, novel_id, status, updated_at DESC);

CREATE TABLE novel.chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  chapter_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  current_version_no INTEGER NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chapters_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT chapters_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id)
    REFERENCES novel.novels(workspace_id, id),
  CONSTRAINT chapters_created_by_user_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES auth.users(id),
  CONSTRAINT chapters_generation_run_fkey FOREIGN KEY (workspace_id, novel_id, source_generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT chapters_status_check CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  CONSTRAINT chapters_number_check CHECK (chapter_no > 0),
  CONSTRAINT chapters_version_check CHECK (current_version_no > 0),
  CONSTRAINT chapters_workspace_novel_no_key UNIQUE (workspace_id, novel_id, chapter_no),
  CONSTRAINT chapters_workspace_novel_id_key UNIQUE (workspace_id, novel_id, id)
);
CREATE UNIQUE INDEX chapters_workspace_idempotency_idx
  ON novel.chapters(workspace_id, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;
CREATE INDEX chapters_workspace_novel_status_idx
  ON novel.chapters(workspace_id, novel_id, status, chapter_no);

CREATE TABLE novel.chapter_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  chapter_id UUID NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content_sha256 TEXT NOT NULL,
  content_bytes BIGINT NOT NULL,
  content_storage_kind TEXT NOT NULL,
  content_text TEXT,
  content_object_key TEXT,
  summary TEXT,
  source_type TEXT NOT NULL,
  source_id UUID,
  created_by_user_id UUID NOT NULL,
  source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chapter_versions_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT chapter_versions_workspace_chapter_fkey FOREIGN KEY (workspace_id, novel_id, chapter_id)
    REFERENCES novel.chapters(workspace_id, novel_id, id),
  CONSTRAINT chapter_versions_created_by_user_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES auth.users(id),
  CONSTRAINT chapter_versions_generation_run_fkey FOREIGN KEY (workspace_id, novel_id, source_generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT chapter_versions_chapter_no_key UNIQUE (workspace_id, chapter_id, version_no),
  CONSTRAINT chapter_versions_status_check CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  CONSTRAINT chapter_versions_number_check CHECK (version_no > 0),
  CONSTRAINT chapter_versions_bytes_check CHECK (content_bytes >= 0),
  CONSTRAINT chapter_versions_storage_check CHECK (
    (content_storage_kind = 'postgres_text' AND content_text IS NOT NULL AND content_object_key IS NULL AND content_bytes <= 1048576)
    OR (content_storage_kind = 'object_storage' AND content_object_key IS NOT NULL AND content_text IS NULL AND content_bytes > 1048576)
  ),
  CONSTRAINT chapter_versions_storage_kind_check CHECK (content_storage_kind IN ('postgres_text', 'object_storage'))
);
CREATE UNIQUE INDEX chapter_versions_workspace_idempotency_idx
  ON novel.chapter_versions(workspace_id, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;
CREATE INDEX chapter_versions_workspace_chapter_idx
  ON novel.chapter_versions(workspace_id, novel_id, chapter_id, version_no DESC);

CREATE TABLE novel.chapter_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  chapter_id UUID NOT NULL,
  chapter_version_id UUID NOT NULL,
  summary_kind TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  source_generation_run_id UUID,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chapter_summaries_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT chapter_summaries_workspace_chapter_fkey FOREIGN KEY (workspace_id, novel_id, chapter_id)
    REFERENCES novel.chapters(workspace_id, novel_id, id),
  CONSTRAINT chapter_summaries_workspace_version_fkey FOREIGN KEY (workspace_id, chapter_version_id)
    REFERENCES novel.chapter_versions(workspace_id, id),
  CONSTRAINT chapter_summaries_created_by_user_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES auth.users(id),
  CONSTRAINT chapter_summaries_generation_run_fkey FOREIGN KEY (workspace_id, novel_id, source_generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT chapter_summaries_kind_check CHECK (summary_kind IN ('short', 'detailed', 'facts')),
  CONSTRAINT chapter_summaries_unique_kind UNIQUE (workspace_id, chapter_version_id, summary_kind)
);
CREATE INDEX chapter_summaries_workspace_chapter_idx
  ON novel.chapter_summaries(workspace_id, novel_id, chapter_id, created_at DESC);

CREATE TABLE novel.story_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  fact_key TEXT NOT NULL,
  statement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes_schema_version INTEGER NOT NULL DEFAULT 1,
  current_version_no INTEGER NOT NULL DEFAULT 1,
  source_chapter_id UUID,
  source_chapter_version_id UUID,
  created_by_user_id UUID NOT NULL,
  source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT story_facts_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT story_facts_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id)
    REFERENCES novel.novels(workspace_id, id),
  CONSTRAINT story_facts_chapter_fkey FOREIGN KEY (workspace_id, novel_id, source_chapter_id)
    REFERENCES novel.chapters(workspace_id, novel_id, id),
  CONSTRAINT story_facts_chapter_version_fkey FOREIGN KEY (workspace_id, source_chapter_version_id)
    REFERENCES novel.chapter_versions(workspace_id, id),
  CONSTRAINT story_facts_created_by_user_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES auth.users(id),
  CONSTRAINT story_facts_generation_run_fkey FOREIGN KEY (workspace_id, novel_id, source_generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT story_facts_status_check CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  CONSTRAINT story_facts_version_check CHECK (current_version_no > 0),
  CONSTRAINT story_facts_schema_version_check CHECK (attributes_schema_version > 0)
);
CREATE UNIQUE INDEX story_facts_workspace_idempotency_idx
  ON novel.story_facts(workspace_id, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX story_facts_workspace_key_idx
  ON novel.story_facts(workspace_id, novel_id, fact_key)
  WHERE deleted_at IS NULL;

CREATE TABLE novel.timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  event_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  sequence_no INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  attributes_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes_schema_version INTEGER NOT NULL DEFAULT 1,
  current_version_no INTEGER NOT NULL DEFAULT 1,
  source_chapter_id UUID,
  source_chapter_version_id UUID,
  created_by_user_id UUID NOT NULL,
  source_generation_run_id UUID,
  source_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT timeline_events_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT timeline_events_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id)
    REFERENCES novel.novels(workspace_id, id),
  CONSTRAINT timeline_events_chapter_fkey FOREIGN KEY (workspace_id, novel_id, source_chapter_id)
    REFERENCES novel.chapters(workspace_id, novel_id, id),
  CONSTRAINT timeline_events_chapter_version_fkey FOREIGN KEY (workspace_id, source_chapter_version_id)
    REFERENCES novel.chapter_versions(workspace_id, id),
  CONSTRAINT timeline_events_created_by_user_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES auth.users(id),
  CONSTRAINT timeline_events_generation_run_fkey FOREIGN KEY (workspace_id, novel_id, source_generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT timeline_events_status_check CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  CONSTRAINT timeline_events_version_check CHECK (current_version_no > 0),
  CONSTRAINT timeline_events_schema_version_check CHECK (attributes_schema_version > 0)
);
CREATE UNIQUE INDEX timeline_events_workspace_idempotency_idx
  ON novel.timeline_events(workspace_id, source_idempotency_key)
  WHERE source_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX timeline_events_workspace_key_idx
  ON novel.timeline_events(workspace_id, novel_id, event_key)
  WHERE deleted_at IS NULL;
CREATE INDEX timeline_events_workspace_novel_sequence_idx
  ON novel.timeline_events(workspace_id, novel_id, sequence_no NULLS LAST, updated_at DESC);

CREATE TABLE ai.generation_context_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  generation_run_id UUID NOT NULL,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  rank INTEGER NOT NULL,
  excerpt_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  selection_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT generation_context_items_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT generation_context_items_generation_run_fkey FOREIGN KEY (workspace_id, novel_id, generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT generation_context_items_rank_check CHECK (rank >= 0),
  CONSTRAINT generation_context_items_token_count_check CHECK (token_count >= 0),
  CONSTRAINT generation_context_items_unique_source UNIQUE (generation_run_id, source_type, source_id)
);
CREATE INDEX generation_context_items_run_rank_idx
  ON ai.generation_context_items(workspace_id, novel_id, generation_run_id, rank);

ALTER TABLE novel.outlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.chapter_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.chapter_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.story_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.generation_context_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY novel_outlines_member_read ON novel.outlines FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_outlines_editor_write ON novel.outlines FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_outlines_worker_draft_insert ON novel.outlines FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_outlines_worker_draft_update ON novel.outlines FOR UPDATE TO dsh_worker_runtime
  USING (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id))
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_outlines_service_publish ON novel.outlines FOR UPDATE TO dsh_service_runtime
  USING (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (status = 'published' AND app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_chapters_member_read ON novel.chapters FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_chapters_editor_write ON novel.chapters FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_chapters_worker_draft_insert ON novel.chapters FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_chapters_worker_draft_update ON novel.chapters FOR UPDATE TO dsh_worker_runtime
  USING (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id))
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_chapters_service_publish ON novel.chapters FOR UPDATE TO dsh_service_runtime
  USING (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (status = 'published' AND app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_chapter_versions_member_read ON novel.chapter_versions FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_chapter_versions_editor_draft_write ON novel.chapter_versions FOR ALL TO dsh_app_runtime
  USING (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_chapter_versions_worker_draft_insert ON novel.chapter_versions FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_chapter_versions_worker_draft_update ON novel.chapter_versions FOR UPDATE TO dsh_worker_runtime
  USING (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id))
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_chapter_versions_service_publish ON novel.chapter_versions FOR UPDATE TO dsh_service_runtime
  USING (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (status = 'published' AND app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_chapter_summaries_member_read ON novel.chapter_summaries FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_chapter_summaries_editor_write ON novel.chapter_summaries FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_chapter_summaries_worker_draft_insert ON novel.chapter_summaries FOR INSERT TO dsh_worker_runtime
  WITH CHECK (app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));

CREATE POLICY novel_story_facts_member_read ON novel.story_facts FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_story_facts_editor_write ON novel.story_facts FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_story_facts_worker_draft_insert ON novel.story_facts FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_story_facts_worker_draft_update ON novel.story_facts FOR UPDATE TO dsh_worker_runtime
  USING (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id))
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_story_facts_service_publish ON novel.story_facts FOR UPDATE TO dsh_service_runtime
  USING (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (status = 'published' AND app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY novel_timeline_events_member_read ON novel.timeline_events FOR SELECT TO dsh_app_runtime,dsh_worker_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY novel_timeline_events_editor_write ON novel.timeline_events FOR ALL TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (app.workspace_access_allowed(workspace_id, 'editor'));
CREATE POLICY novel_timeline_events_worker_draft_insert ON novel.timeline_events FOR INSERT TO dsh_worker_runtime
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_timeline_events_worker_draft_update ON novel.timeline_events FOR UPDATE TO dsh_worker_runtime
  USING (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id))
  WITH CHECK (status = 'draft' AND app.agent_run_allowed(workspace_id, novel_id, source_generation_run_id));
CREATE POLICY novel_timeline_events_service_publish ON novel.timeline_events FOR UPDATE TO dsh_service_runtime
  USING (status = 'draft' AND app.workspace_access_allowed(workspace_id, 'editor'))
  WITH CHECK (status = 'published' AND app.workspace_access_allowed(workspace_id, 'editor'));

CREATE POLICY ai_generation_context_items_app_read ON ai.generation_context_items FOR SELECT TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY ai_generation_context_items_worker_read ON ai.generation_context_items FOR SELECT TO dsh_worker_runtime
  USING (app.agent_run_allowed(workspace_id, novel_id, generation_run_id));
CREATE POLICY ai_generation_context_items_worker_insert ON ai.generation_context_items FOR INSERT TO dsh_worker_runtime
  WITH CHECK (app.agent_run_allowed(workspace_id, novel_id, generation_run_id));
CREATE POLICY ai_generation_context_items_service_read ON ai.generation_context_items FOR SELECT TO dsh_service_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'));

GRANT SELECT, INSERT, UPDATE ON novel.outlines, novel.chapters, novel.chapter_versions,
  novel.chapter_summaries, novel.story_facts, novel.timeline_events TO dsh_app_runtime;
GRANT SELECT, INSERT, UPDATE ON novel.outlines, novel.chapters, novel.chapter_versions,
  novel.chapter_summaries, novel.story_facts, novel.timeline_events TO dsh_worker_runtime;
GRANT SELECT, UPDATE ON novel.outlines, novel.chapters, novel.chapter_versions,
  novel.chapter_summaries, novel.story_facts, novel.timeline_events TO dsh_service_runtime;
GRANT SELECT ON novel.outlines, novel.chapters, novel.chapter_versions, novel.chapter_summaries,
  novel.story_facts, novel.timeline_events TO dsh_readonly;
GRANT SELECT, INSERT ON ai.generation_context_items TO dsh_worker_runtime;
GRANT SELECT ON ai.generation_context_items TO dsh_app_runtime,dsh_service_runtime,dsh_readonly;
GRANT ALL PRIVILEGES ON novel.outlines, novel.chapters, novel.chapter_versions, novel.chapter_summaries,
  novel.story_facts, novel.timeline_events, ai.generation_context_items TO dsh_migrator;

REVOKE ALL ON novel.outlines, novel.chapters, novel.chapter_versions, novel.chapter_summaries,
  novel.story_facts, novel.timeline_events, ai.generation_context_items FROM PUBLIC;
