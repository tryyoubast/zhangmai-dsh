-- Repair the queue-claim RLS boundary for databases that already applied 0010.
-- Ordinary worker writes require a run already bound to the current agent;
-- only the claim policy may inspect a browser-owned queued run.

CREATE OR REPLACE FUNCTION app.agent_run_allowed(
  requested_workspace_id UUID, requested_novel_id UUID, requested_run_id UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, ai AS $$
  SELECT app.current_database_role() = 'dsh_worker_runtime'
    AND app.current_actor_type() = 'agent'
    AND requested_workspace_id = app.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM ai.generation_runs AS run
      WHERE run.id = requested_run_id
        AND run.workspace_id = requested_workspace_id
        AND run.novel_id = requested_novel_id
        AND run.initiated_by_user_id = app.current_user_id()
        AND run.source_session_id IS NOT NULL
        AND run.agent_principal_id = app.current_agent_principal_id()
        AND app.workspace_access_allowed(requested_workspace_id, 'editor')
    )
$$;

CREATE OR REPLACE FUNCTION app.generation_run_claim_allowed(
  requested_workspace_id UUID, requested_novel_id UUID, requested_run_id UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, ai AS $$
  SELECT app.current_database_role() = 'dsh_worker_runtime'
    AND app.current_actor_type() = 'agent'
    AND app.current_agent_principal_id() IS NOT NULL
    AND requested_workspace_id = app.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM ai.generation_runs AS run
      WHERE run.id = requested_run_id
        AND run.workspace_id = requested_workspace_id
        AND run.novel_id = requested_novel_id
        AND run.status = 'queued'
        AND run.agent_principal_id = 'user-request'
        AND run.initiated_by_user_id = app.current_user_id()
        AND run.source_session_id IS NOT NULL
        AND app.workspace_access_allowed(requested_workspace_id, 'editor')
    )
$$;
REVOKE EXECUTE ON FUNCTION app.generation_run_claim_allowed(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.generation_run_claim_allowed(UUID,UUID,UUID) TO dsh_worker_runtime;

DROP POLICY ai_runs_worker_update ON ai.generation_runs;
CREATE POLICY ai_runs_worker_update ON ai.generation_runs
FOR UPDATE TO dsh_worker_runtime
USING (
  status IN ('queued', 'running')
  AND (
    app.agent_run_allowed(workspace_id, novel_id, id)
    OR app.generation_run_claim_allowed(workspace_id, novel_id, id)
  )
)
WITH CHECK (
  (
    status IN ('running', 'completed', 'failed', 'cancelled')
    OR (
      status = 'queued'
      AND agent_principal_id = app.current_agent_principal_id()
    )
  )
  AND app.agent_run_allowed(workspace_id, novel_id, id)
);
