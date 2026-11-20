-- Membership history is visible only through the transaction's authenticated user context.
CREATE FUNCTION app.current_user_workspace_memberships()
RETURNS TABLE (workspace_id UUID, role TEXT, revoked_at TIMESTAMPTZ, workspace_status TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT member.workspace_id, member.role, member.revoked_at, workspace.status
  FROM app.workspace_members AS member
  JOIN app.workspaces AS workspace ON workspace.id = member.workspace_id
  WHERE member.user_id = app.current_user_id()
    AND app.current_database_role() = 'dsh_app_runtime'
    AND app.current_actor_type() = 'user'
  ORDER BY member.created_at, member.workspace_id
$$;
ALTER FUNCTION app.current_user_workspace_memberships() OWNER TO dsh_migrator;
REVOKE ALL ON FUNCTION app.current_user_workspace_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_workspace_memberships() TO dsh_app_runtime;
