-- Index the bounded context excerpts used by novel context retrieval.
CREATE INDEX novel_outlines_context_search_idx
  ON novel.outlines USING gin (to_tsvector('simple', left(title || E'\n' || content_jsonb::text, 16384)));

CREATE INDEX novel_chapters_context_search_idx
  ON novel.chapters USING gin (to_tsvector('simple', left(title || E'\n' || coalesce(summary, ''), 16384)));

CREATE INDEX novel_chapter_summaries_context_search_idx
  ON novel.chapter_summaries USING gin (to_tsvector('simple', left(content_text, 16384)));

CREATE INDEX novel_story_facts_context_search_idx
  ON novel.story_facts USING gin (to_tsvector('simple', left(fact_key || E'\n' || statement || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_timeline_events_context_search_idx
  ON novel.timeline_events USING gin (to_tsvector('simple', left(title || E'\n' || coalesce(description, '') || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_characters_context_search_idx
  ON novel.characters USING gin (to_tsvector('simple', left(name || E'\n' || coalesce(summary, '') || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_skills_context_search_idx
  ON novel.skills USING gin (to_tsvector('simple', left(name || E'\n' || coalesce(summary, '') || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_locations_context_search_idx
  ON novel.locations USING gin (to_tsvector('simple', left(name || E'\n' || coalesce(summary, '') || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_factions_context_search_idx
  ON novel.factions USING gin (to_tsvector('simple', left(name || E'\n' || coalesce(summary, '') || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_items_context_search_idx
  ON novel.items USING gin (to_tsvector('simple', left(name || E'\n' || coalesce(summary, '') || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_storylines_context_search_idx
  ON novel.storylines USING gin (to_tsvector('simple', left(name || E'\n' || coalesce(summary, '') || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_chapter_versions_context_search_idx
  ON novel.chapter_versions USING gin (to_tsvector('simple', left(coalesce(summary, '') || E'\n' || coalesce(content_text, content_object_key, ''), 16384)));

CREATE INDEX novel_entity_relations_context_search_idx
  ON novel.entity_relations USING gin (to_tsvector('simple', left(source_entity_type || ':' || source_entity_id::text || ' ' || relation_type || ' ' || target_entity_type || ':' || target_entity_id::text || E'\n' || attributes_jsonb::text, 16384)));

CREATE INDEX novel_character_skills_context_search_idx
  ON novel.character_skills USING gin (to_tsvector('simple', left(relation_type || E'\n' || attributes_jsonb::text, 16384)));
