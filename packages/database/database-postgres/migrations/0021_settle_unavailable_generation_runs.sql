-- Leave recoverable deliveries pending; settle only matching runs with no usable authority.
CREATE FUNCTION ai.settle_generation_run_without_authority(
  requested_workspace_id UUID, requested_run_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, ai, app AS $$
BEGIN
  IF app.current_database_role() IS DISTINCT FROM 'dsh_worker_runtime'
    OR app.current_actor_type() IS DISTINCT FROM 'agent'
    OR app.current_agent_principal_id() IS NULL
    OR app.current_workspace_id() IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='generation settlement requires a trusted worker context';
  END IF;

  PERFORM 1 FROM ai.generation_runs AS run
    WHERE run.id = requested_run_id AND run.workspace_id = requested_workspace_id
      AND run.status IN ('queued', 'running')
      AND (run.agent_principal_id = app.current_agent_principal_id()
        OR (run.status = 'queued' AND run.agent_principal_id = 'user-request'))
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN TRUE; END IF;

  IF EXISTS (SELECT 1 FROM ai.resolve_generation_run_worker_identity(requested_workspace_id, requested_run_id))
    THEN RETURN FALSE;
  END IF;

  UPDATE ai.generation_runs SET status = 'failed', completed_at = statement_timestamp(),
    error_code = 'GENERATION_AUTHORITY_UNAVAILABLE',
    error_summary = 'Generation authorization is unavailable; submit a new request to continue.'
    WHERE id = requested_run_id AND workspace_id = requested_workspace_id;
  RETURN TRUE;
END
$$;
ALTER FUNCTION ai.settle_generation_run_without_authority(UUID, UUID) OWNER TO dsh_migrator;
REVOKE ALL ON FUNCTION ai.settle_generation_run_without_authority(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.settle_generation_run_without_authority(UUID, UUID) TO dsh_worker_runtime;
