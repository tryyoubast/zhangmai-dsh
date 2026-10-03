CREATE TABLE ai.generation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  novel_id UUID NOT NULL,
  generation_run_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  selected_context JSONB NOT NULL DEFAULT '[]'::jsonb,
  records JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposals JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT generation_results_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT generation_results_workspace_novel_fkey FOREIGN KEY (workspace_id, novel_id)
    REFERENCES novel.novels(workspace_id, id),
  CONSTRAINT generation_results_workspace_novel_run_fkey FOREIGN KEY (workspace_id, novel_id, generation_run_id)
    REFERENCES ai.generation_runs(workspace_id, novel_id, id),
  CONSTRAINT generation_results_idempotency_key_check CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT generation_results_selected_context_array_check CHECK (jsonb_typeof(selected_context) = 'array'),
  CONSTRAINT generation_results_records_array_check CHECK (jsonb_typeof(records) = 'array'),
  CONSTRAINT generation_results_proposals_array_check CHECK (jsonb_typeof(proposals) = 'array'),
  CONSTRAINT generation_results_workspace_novel_idempotency_key UNIQUE (workspace_id, novel_id, idempotency_key)
);

CREATE INDEX generation_results_workspace_run_idx
  ON ai.generation_results(workspace_id, novel_id, generation_run_id, created_at DESC);

ALTER TABLE ai.generation_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_generation_results_app_read ON ai.generation_results FOR SELECT TO dsh_app_runtime
  USING (app.workspace_access_allowed(workspace_id, 'member'));
CREATE POLICY ai_generation_results_worker_read ON ai.generation_results FOR SELECT TO dsh_worker_runtime
  USING (app.agent_run_allowed(workspace_id, novel_id, generation_run_id));
CREATE POLICY ai_generation_results_worker_write ON ai.generation_results FOR INSERT TO dsh_worker_runtime
  WITH CHECK (app.agent_run_allowed(workspace_id, novel_id, generation_run_id));
CREATE POLICY ai_generation_results_service_read ON ai.generation_results FOR SELECT TO dsh_service_runtime
  USING (app.workspace_access_allowed(workspace_id, 'editor'));

GRANT SELECT ON ai.generation_results TO dsh_app_runtime, dsh_worker_runtime, dsh_service_runtime, dsh_readonly;
GRANT INSERT ON ai.generation_results TO dsh_worker_runtime;
GRANT ALL PRIVILEGES ON ai.generation_results TO dsh_migrator;
REVOKE ALL ON ai.generation_results FROM PUBLIC;
