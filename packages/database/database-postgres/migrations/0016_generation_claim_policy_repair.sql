-- Permit the approved worker claim read and its unchanged queued postcondition.
DROP POLICY IF EXISTS ai_runs_worker_claim_read ON ai.generation_runs;
CREATE POLICY ai_runs_worker_claim_read ON ai.generation_runs FOR SELECT TO dsh_worker_runtime
USING (app.generation_run_claim_allowed(workspace_id, novel_id, id));

DROP POLICY ai_runs_worker_update ON ai.generation_runs;
CREATE POLICY ai_runs_worker_update ON ai.generation_runs FOR UPDATE TO dsh_worker_runtime
USING (
  status IN ('queued', 'running')
  AND (app.agent_run_allowed(workspace_id, novel_id, id)
    OR app.generation_run_claim_allowed(workspace_id, novel_id, id))
)
WITH CHECK (
  (status IN ('running', 'completed', 'failed', 'cancelled')
    AND app.agent_run_allowed(workspace_id, novel_id, id))
  OR (status = 'queued' AND agent_principal_id = app.current_agent_principal_id()
    AND (app.agent_run_allowed(workspace_id, novel_id, id)
      OR app.generation_run_claim_allowed(workspace_id, novel_id, id)))
);
