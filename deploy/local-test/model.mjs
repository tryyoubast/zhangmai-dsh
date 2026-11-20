/** Keyless, internal-only structured-output fixture used by the Compose acceptance suite. */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const content = 'Lin arrives at Moon Harbor and finds the sealed letter.'
const records = [
  { targetType: 'characters', clientKey: 'hero', name: 'Lin', summary: 'Courier of Moon Harbor' },
  { targetType: 'skills', clientKey: 'skill', name: 'Navigation', summary: 'Reads coastal maps' },
  { targetType: 'locations', clientKey: 'harbor', name: 'Moon Harbor', summary: 'A sheltered port' },
  { targetType: 'factions', name: 'Harbor Guild', summary: 'Keeps the charts' },
  { targetType: 'items', name: 'Sealed letter', summary: 'A message from the captain' },
  { targetType: 'storylines', name: 'The letter', summary: 'Lin follows its trail' },
  { targetType: 'outlines', name: 'Arrival', title: 'Arrival', attributes: { beats: ['arrival', 'discovery'] } },
  { targetType: 'entity_relations', sourceEntityType: 'characters', sourceEntityRef: 'hero', targetEntityType: 'locations', targetEntityRef: 'harbor', relationType: 'visits' },
  { targetType: 'character_skills', characterRef: 'hero', skillRef: 'skill', relationType: 'knows' },
  { targetType: 'chapters', clientKey: 'chapter', chapterNo: 1, title: 'Moon Harbor', summary: 'Lin finds the letter' },
  { targetType: 'chapter_versions', clientKey: 'version', chapterRef: 'chapter', versionNo: 1, contentText: content, contentStorageKind: 'postgres_text', contentSha256: hash(content), contentBytes: Buffer.byteLength(content) },
  { targetType: 'chapter_summaries', chapterRef: 'chapter', chapterVersionRef: 'version', summaryKind: 'short', contentText: 'Lin finds the letter in Moon Harbor.', contentSha256: hash('Lin finds the letter in Moon Harbor.') },
  { targetType: 'story_facts', factKey: 'harbor.letter', statement: 'The sealed letter belongs to Lin.' },
  { targetType: 'timeline_events', eventKey: 'arrival', title: 'Lin arrives', description: 'The courier reaches the harbor', sequenceNo: 1 },
]
const calls = new Map()
const held = new Set()
const server = createServer(async (request, response) => {
  const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
  if (request.url === '/health') return json(200, { ready: true })
  if (request.url === '/stats') return json(200, { calls: Object.fromEntries(calls), pending: held.size })
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(404, { error: 'not_found' })
  try {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 262144) return json(413, { error: 'too_large' })
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content)
    const key = input.idempotencyKey
    calls.set(key, (calls.get(key) ?? 0) + 1)
    let output = { records, proposals: [] }
    if (input.instruction === 'Continue the saved Moon Harbor story context. Return only JSON with records: one new character named Lantern Courier (targetType characters, name, summary), one new location named Lantern Pier (targetType locations, name, summary), and chapter 2 (targetType chapters, chapterNo:2, title:Moon Harbor Continuation, summary). Keep the combined prose under 120 words. Drafts only; do not update or publish existing records.') {
      output = { records: [
        { targetType: 'characters', name: 'Lantern Courier', summary: `Restored ${input.context.length} context items` },
        { targetType: 'locations', name: 'Lantern Pier', summary: 'A landing in Moon Harbor' },
        { targetType: 'chapters', chapterNo: 2, title: 'Moon Harbor Continuation', summary: 'The courier reaches the pier.' },
      ], proposals: [] }
    }
    if (input.instruction.includes('fixture:invalid')) output = { records: [null] }
    if (input.instruction.includes('fixture:sql')) output = { records: [{ targetType: 'characters', name: 'Unsafe', sql: 'DROP TABLE auth.users' }] }
    if (input.instruction.includes('fixture:published')) output = { records: [{ targetType: 'characters', name: 'Unsafe', status: 'published' }] }
    if (input.instruction.includes('fixture:partial')) output = { records: [{ targetType: 'characters', name: 'Retained partial draft' }, { targetType: 'locations', name: 42 }] }
    if (input.instruction.includes('fixture:hold')) {
      held.add(response)
      response.once('close', () => { held.delete(response) })
      return
    }
    if (input.instruction.includes('fixture:continuation') || input.instruction === 'Moon Harbor') {
      output = { records: [{ targetType: 'characters', name: 'Continuation courier', summary: `Restored ${input.context.length} context items` }], proposals: [] }
    }
    if (input.instruction.startsWith('fixture:proposal ')) {
      output = { records: [], proposals: [JSON.parse(input.instruction.slice('fixture:proposal '.length))] }
    }
    json(200, { choices: [{ message: { content: JSON.stringify(output) } }] })
  } catch {
    json(400, { error: 'invalid_fixture_request' })
  }
})
server.listen(Number(process.env.DSH_FIXTURE_PORT ?? 8081), process.env.DSH_FIXTURE_HOST ?? '0.0.0.0', () => {
  const address = server.address()
  if (typeof address === 'object' && address !== null) process.send?.({ port: address.port })
})
const close = () => {
  for (const response of held) response.destroy()
  server.closeAllConnections()
  server.close()
}
process.once('SIGTERM', close)
process.once('SIGINT', close)
