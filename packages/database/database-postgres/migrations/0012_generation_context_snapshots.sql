-- Persist the exact model-visible context and source lifecycle state per run.
ALTER TABLE ai.generation_context_items
  ADD COLUMN excerpt TEXT,
  ADD COLUMN source_status TEXT;

ALTER TABLE ai.generation_context_items
  ADD CONSTRAINT generation_context_items_source_status_check
    CHECK (source_status IS NULL OR source_status IN ('draft', 'published', 'archived', 'deleted')),
  ADD CONSTRAINT generation_context_items_snapshot_pair_check
    CHECK ((excerpt IS NULL) = (source_status IS NULL));
