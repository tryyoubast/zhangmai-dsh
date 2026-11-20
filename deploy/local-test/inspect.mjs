/** Read fixture evidence with the migrator login; runtime containers never receive this tool's credentials. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const { Client } = createRequire(new URL('../../packages/database/database-postgres/package.json', import.meta.url))('pg')
const directory = process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets'
const host = process.env.DSH_NOVEL_DATABASE_HOST ?? 'postgres'
if (!['postgres', '127.0.0.1'].includes(host)) throw new Error('Inspection is restricted to the isolated staging host')
const port = process.env.DSH_NOVEL_DATABASE_PORT ?? '5432'
const args = process.argv.slice(2)
const uuid = value => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value ?? '')) throw new Error('Inspection requires UUID locators')
  return value
}
const client = new Client({
  host, port: Number(port), database: 'dsh_staging_test', user: 'staging_migrator',
  password: (await readFile(`${directory}/migrator-password`, 'utf8')).trim(),
})
const tables = ['characters', 'skills', 'locations', 'factions', 'items', 'storylines', 'outlines', 'entity_relations',
  'character_skills', 'chapters', 'chapter_versions', 'chapter_summaries', 'story_facts', 'timeline_events']

async function inspect() {
  await client.connect()
  const login = (await client.query(`SELECT rolsuper,rolbypassrls,
    ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname<>session_user AND pg_has_role(session_user,oid,'MEMBER')) AS memberships
    FROM pg_roles WHERE rolname=session_user`)).rows[0]
  if (login.rolsuper || login.rolbypassrls || login.memberships.length !== 1 || login.memberships[0] !== 'dsh_migrator') {
    throw new Error('Inspection requires the restricted staging migrator')
  }
  await client.query('SET ROLE dsh_migrator')
  await client.query('BEGIN READ ONLY')
  if (args[0] === 'workspace') {
    const userId = uuid(args[1])
    const result = await client.query(`SELECT
      (SELECT count(*)::integer FROM app.workspace_members WHERE user_id=$1) AS memberships,
      (SELECT count(*)::integer FROM app.workspaces WHERE owner_user_id=$1) AS "ownedWorkspaces"`, [userId])
    return result.rows[0]
  }
  if (args[0] === 'target') {
    const type = args[3]
    if (!['characters', 'locations'].includes(type)) throw new Error('Only the two publication fixtures have a target projection')
    const result = await client.query(`SELECT name,summary,current_version_no AS "versionNo",status
      FROM novel.${type} WHERE workspace_id=$1 AND novel_id=$2 AND id=$3`, [uuid(args[1]), uuid(args[2]), uuid(args[4])])
    if (result.rows.length !== 1) throw new Error('Inspection fixture target was not found')
    return result.rows[0]
  }
  if (args[0] === 'run') {
    const values = [uuid(args[1]), uuid(args[2]), uuid(args[3])]
    const targets = await client.query(tables.map(table =>
      `SELECT id,status,'${table}' AS "targetType" FROM novel.${table} WHERE workspace_id=$1 AND novel_id=$2 AND source_generation_run_id=$3`).join(' UNION ALL '), values)
    const chapters = await client.query(`SELECT chapter_no FROM novel.chapters
      WHERE workspace_id=$1 AND novel_id=$2 AND source_generation_run_id=$3 ORDER BY chapter_no`, values)
    const result = await client.query(`SELECT idempotency_key,
      (SELECT count(*)::integer FROM ai.generation_results WHERE workspace_id=$1 AND novel_id=$2 AND generation_run_id=$3) AS "savedResults",
      (SELECT count(*)::integer FROM ai.generation_proposals WHERE workspace_id=$1 AND novel_id=$2 AND generation_run_id=$3) AS proposals
      FROM ai.generation_runs WHERE workspace_id=$1 AND novel_id=$2 AND id=$3`, values)
    if (result.rows.length !== 1) throw new Error('Inspection fixture run was not found')
    const response = await fetch(process.env.DSH_NOVEL_PROVIDER_STATS_URL ?? 'http://model:8081/stats', { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error('The fixed model statistics are unavailable')
    const stats = await response.json()
    return {
      proposals: result.rows[0].proposals,
      savedResults: result.rows[0].savedResults,
      targets: targets.rows,
      chapterNumbers: chapters.rows.map(row => row.chapter_no),
      draftTargets: targets.rows.filter(row => row.status === 'draft').length,
      publishedTargets: targets.rows.filter(row => row.status === 'published').length,
      providerCalls: stats.calls[result.rows[0].idempotency_key] ?? 0,
    }
  }
  throw new Error('Unknown staging inspection operation')
}

try {
  console.log(JSON.stringify(await inspect()))
} catch {
  console.error('Staging inspection failed; credentials and fixture contents are redacted.')
  process.exitCode = 1
} finally {
  await client.end()
}
