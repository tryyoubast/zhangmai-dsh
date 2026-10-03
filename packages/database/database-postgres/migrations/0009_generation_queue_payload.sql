ALTER TABLE ai.generation_runs
  ADD COLUMN instruction TEXT NOT NULL DEFAULT '',
  ADD COLUMN context_limit INTEGER NOT NULL DEFAULT 8;

ALTER TABLE ai.generation_runs
  ADD CONSTRAINT generation_runs_instruction_length_check
    CHECK (length(instruction) <= 100000),
  ADD CONSTRAINT generation_runs_context_limit_check
    CHECK (context_limit >= 0 AND context_limit <= 128);

COMMENT ON COLUMN ai.generation_runs.instruction IS
  'User-authored generation instruction retained so a worker can replay a queued run.';
COMMENT ON COLUMN ai.generation_runs.context_limit IS
  'Maximum number of persisted context items requested by the user.';
