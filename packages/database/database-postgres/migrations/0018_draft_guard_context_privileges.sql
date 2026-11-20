-- Draft publication guards evaluate this invoker-only predicate for ordinary writes.
-- Only the service role can satisfy its rollback-context checks.
GRANT EXECUTE ON FUNCTION novel.rollback_context_active()
  TO dsh_app_runtime, dsh_worker_runtime;
