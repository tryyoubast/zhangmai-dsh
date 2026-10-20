-- Allow an authenticated worker to atomically claim a browser-created queued run.
-- The claim only changes worker ownership; the run remains queued until the worker
-- performs the normal queued -> running transition.

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
        AND (
          run.agent_principal_id = app.current_agent_principal_id()
          OR (run.status = 'queued' AND run.agent_principal_id = 'user-request')
        )
        AND app.workspace_access_allowed(requested_workspace_id, 'editor')
    )
$$;

CREATE OR REPLACE FUNCTION ai.claim_generation_run(
  requested_workspace_id UUID, requested_novel_id UUID, requested_run_id UUID
)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = pg_catalog, app, ai AS $$
DECLARE claimed_id UUID;
BEGIN
  IF app.current_database_role() <> 'dsh_worker_runtime'
    OR app.current_actor_type() <> 'agent'
    OR app.current_agent_principal_id() IS NULL
    OR requested_workspace_id IS DISTINCT FROM app.current_workspace_id()
    OR NOT app.workspace_access_allowed(requested_workspace_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'only a bound generation worker may claim a run';
  END IF;

  UPDATE ai.generation_runs AS run
  SET agent_principal_id = app.current_agent_principal_id()
  WHERE run.workspace_id = requested_workspace_id
    AND run.novel_id = requested_novel_id
    AND run.id = requested_run_id
    AND run.status = 'queued'
    AND run.agent_principal_id = 'user-request'
    AND run.initiated_by_user_id = app.current_user_id()
    AND run.source_session_id IS NOT NULL
  RETURNING id INTO claimed_id;

  IF claimed_id IS NOT NULL THEN RETURN TRUE; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM ai.generation_runs AS run
    WHERE run.workspace_id = requested_workspace_id
      AND run.novel_id = requested_novel_id
      AND run.id = requested_run_id
      AND run.status = 'queued'
      AND run.agent_principal_id = app.current_agent_principal_id()
      AND run.initiated_by_user_id = app.current_user_id()
  );
END
$$;
REVOKE EXECUTE ON FUNCTION ai.claim_generation_run(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.claim_generation_run(UUID,UUID,UUID) TO dsh_worker_runtime;

CREATE OR REPLACE FUNCTION ai.guard_generation_run_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IN ('dsh_app_runtime', 'dsh_worker_runtime') THEN
      IF NEW.status <> 'queued' OR NEW.source_session_id IS NULL OR NEW.idempotency_key IS NULL
        OR NEW.initiated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='new generation runs require the authenticated user, source session, and idempotency key';
      END IF;
      IF current_user = 'dsh_worker_runtime'
        AND NEW.agent_principal_id IS DISTINCT FROM app.current_agent_principal_id() THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers cannot create runs for another agent';
      END IF;
      IF NEW.heartbeat_at IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.error_summary IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='new generation runs cannot contain worker progress or errors';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF current_user = 'dsh_worker_runtime' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.novel_id IS DISTINCT FROM OLD.novel_id
      OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id OR NEW.model IS DISTINCT FROM OLD.model
      OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
      OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR (NEW.agent_principal_id IS DISTINCT FROM OLD.agent_principal_id AND NOT (
        OLD.status = 'queued' AND NEW.status = 'queued'
        AND OLD.agent_principal_id = 'user-request'
        AND NEW.agent_principal_id = app.current_agent_principal_id()
      ))
      OR (NEW.error_code IS NOT NULL AND NEW.error_code !~ '^[A-Z][A-Z0-9_]{0,127}$') THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='AI workers cannot change run ownership or inputs';
    END IF;
    IF NOT ((OLD.status='queued' AND NEW.status='running')
      OR (OLD.status='running' AND NEW.status IN ('running','completed','failed','cancelled'))
      OR (OLD.status='queued' AND NEW.status='queued'
        AND OLD.agent_principal_id = 'user-request'
        AND NEW.agent_principal_id = app.current_agent_principal_id())) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='invalid generation run state transition';
    END IF;
    IF (NEW.status='running' AND NEW.completed_at IS NOT NULL)
      OR (NEW.status='completed' AND NEW.completed_at IS NULL)
      OR (NEW.status='running' AND NEW.heartbeat_at IS NULL)
      OR (OLD.heartbeat_at IS NOT NULL AND (NEW.heartbeat_at IS NULL OR NEW.heartbeat_at < OLD.heartbeat_at))
      OR (NEW.heartbeat_at IS NOT NULL AND NEW.heartbeat_at > statement_timestamp())
      OR (NEW.completed_at IS NOT NULL AND NEW.completed_at > statement_timestamp()) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='generation run completion time must match its terminal status';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION ai.guard_generation_run_transition() FROM PUBLIC;
