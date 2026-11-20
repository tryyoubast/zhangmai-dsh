-- Publication guards include this worker-only predicate in shared role expressions.
-- The predicate's actual-role check still returns false for app and service callers.
GRANT EXECUTE ON FUNCTION app.agent_run_allowed(UUID, UUID, UUID)
  TO dsh_app_runtime, dsh_service_runtime;
