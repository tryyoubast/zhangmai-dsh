-- Run once as a PostgreSQL superuser after applying migration 0001 and before migration 0002.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'this bootstrap must run as a PostgreSQL superuser';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsh_migrator') THEN
    RAISE EXCEPTION 'role dsh_migrator does not exist; apply migration 0001 first';
  END IF;
END
$$;

ALTER SCHEMA auth OWNER TO dsh_migrator;
ALTER SCHEMA app OWNER TO dsh_migrator;
ALTER SCHEMA novel OWNER TO dsh_migrator;
ALTER SCHEMA ai OWNER TO dsh_migrator;
ALTER SCHEMA security OWNER TO dsh_migrator;
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION dsh_migrator;
ALTER SCHEMA drizzle OWNER TO dsh_migrator;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'b1cba8ffdd5b97e770bf6e7b72f57ab3f5d7c631065f022cd417a9a7f183ac0d', 1789689600000
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1789689600000
);

DO $$
DECLARE
  object_record record;
  object_kind text;
BEGIN
  FOR object_record IN
    SELECT namespace.nspname, relation.relname, relation.relkind
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('auth', 'app', 'novel', 'ai', 'security', 'drizzle')
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND relation.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'dsh_migrator')
      AND (
        relation.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_depend AS dependency
          WHERE dependency.classid = 'pg_class'::regclass
            AND dependency.objid = relation.oid
            AND dependency.deptype IN ('a', 'i')
        )
      )
  LOOP
    object_kind := CASE object_record.relkind
      WHEN 'S' THEN 'SEQUENCE'
      WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'f' THEN 'FOREIGN TABLE'
      ELSE 'TABLE'
    END;
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO dsh_migrator',
      object_kind, object_record.nspname, object_record.relname
    );
  END LOOP;

  FOR object_record IN
    SELECT namespace.nspname, procedure.proname,
      pg_get_function_identity_arguments(procedure.oid) AS arguments,
      procedure.prokind
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname IN ('auth', 'app', 'novel', 'ai', 'security', 'drizzle')
      AND procedure.prokind IN ('f', 'p')
      AND procedure.proowner <> (SELECT oid FROM pg_roles WHERE rolname = 'dsh_migrator')
  LOOP
    object_kind := CASE object_record.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END;
    EXECUTE format(
      'ALTER %s %I.%I(%s) OWNER TO dsh_migrator',
      object_kind, object_record.nspname, object_record.proname, object_record.arguments
    );
  END LOOP;
END
$$;

ALTER ROLE dsh_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

COMMIT;
