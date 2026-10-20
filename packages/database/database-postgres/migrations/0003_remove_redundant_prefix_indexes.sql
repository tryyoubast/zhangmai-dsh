BEGIN;

DO $$
BEGIN
  IF current_user <> 'dsh_migrator' THEN
    RAISE EXCEPTION 'migration 0003 must run as dsh_migrator';
  END IF;
END
$$;

DROP INDEX IF EXISTS novel.novel_novels_workspace_idx;
DROP INDEX IF EXISTS novel.novel_characters_workspace_novel_idx;
DROP INDEX IF EXISTS novel.novel_skills_workspace_novel_idx;
DROP INDEX IF EXISTS novel.novel_character_skills_workspace_idx;

COMMIT;
