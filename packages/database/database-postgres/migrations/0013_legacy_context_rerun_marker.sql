-- Mark incomplete runs whose pre-0012 context rows cannot be faithfully restored.
-- Keep the original references and hashes; never synthesize historical excerpts.
ALTER TABLE ai.generation_context_items
  ADD COLUMN requires_rerun BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE ai.generation_context_items AS item
SET requires_rerun = TRUE
FROM ai.generation_runs AS run
WHERE run.id = item.generation_run_id
  AND run.workspace_id = item.workspace_id
  AND run.novel_id = item.novel_id
  AND run.status IN ('queued', 'running', 'failed', 'cancelled')
  AND (item.excerpt IS NULL OR item.source_status IS NULL);

COMMENT ON COLUMN ai.generation_context_items.requires_rerun IS
  'True for legacy context without a restorable snapshot; rerun with a new generation run and idempotency key.';
