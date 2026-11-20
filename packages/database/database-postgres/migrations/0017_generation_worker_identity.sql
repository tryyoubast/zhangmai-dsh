-- Resolve persisted queue authority without granting authentication-table reads.
CREATE FUNCTION ai.resolve_generation_run_worker_identity(
  requested_workspace_id UUID, requested_run_id UUID
)
RETURNS TABLE (
  user_id UUID, session_id UUID, workspace_id UUID, novel_id UUID,
  member_role TEXT, run_status TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, ai, auth
AS $$
  SELECT run.initiated_by_user_id, run.source_session_id, run.workspace_id,
    run.novel_id, member.role, run.status
  FROM ai.generation_runs AS run
  JOIN auth.sessions AS session ON session.id = run.source_session_id
    AND session.user_id = run.initiated_by_user_id
  JOIN auth.users AS account ON account.id = run.initiated_by_user_id
  JOIN app.workspace_members AS member ON member.workspace_id = run.workspace_id
    AND member.user_id = run.initiated_by_user_id
  JOIN app.workspaces AS workspace ON workspace.id = run.workspace_id
  WHERE app.current_database_role() = 'dsh_worker_runtime'
    AND app.current_actor_type() = 'agent'
    AND app.current_agent_principal_id() IS NOT NULL
    AND requested_workspace_id = app.current_workspace_id()
    AND run.workspace_id = requested_workspace_id
    AND run.id = requested_run_id
    AND (run.agent_principal_id = app.current_agent_principal_id()
      OR (run.status = 'queued' AND run.agent_principal_id = 'user-request'))
    AND session.revoked_at IS NULL AND session.expires_at > statement_timestamp()
    AND account.status = 'active' AND account.email_verified_at IS NOT NULL
    AND account.deleted_at IS NULL
    AND member.revoked_at IS NULL AND member.role IN ('owner', 'admin', 'editor')
    AND workspace.status = 'active' AND workspace.deleted_at IS NULL
$$;
ALTER FUNCTION ai.resolve_generation_run_worker_identity(UUID,UUID) OWNER TO dsh_migrator;
REVOKE EXECUTE ON FUNCTION ai.resolve_generation_run_worker_identity(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.resolve_generation_run_worker_identity(UUID,UUID) TO dsh_worker_runtime;
