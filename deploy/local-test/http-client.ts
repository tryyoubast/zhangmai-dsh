/** HTTPS and cookie transport for the local acceptance runner. */
import { CookieJar } from 'tough-cookie'
import { request } from 'node:https'

/** Acceptance client with an isolated browser cookie jar. */
export class StagingHttpClient {
  readonly jar = new CookieJar()
  constructor(readonly origin: string, readonly ca: string) {
    if (new URL(origin).protocol !== 'https:') throw new Error('Acceptance requires an HTTPS origin')
  }

  /** Send one bounded JSON request using the explicitly supplied local CA. */
  async request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{
    status: number; headers: Record<string, string | string[] | undefined>; body: unknown
  }> {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin) throw new Error('Acceptance request must stay on the configured origin')
    const cookie = await this.jar.getCookieString(url.href)
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const result = await new Promise<{
      status: number; headers: Record<string, string | string[] | undefined>; text: string
    }>((settle, reject) => {
      const outgoing = request(url, {
        method: options.method ?? 'GET', ca: this.ca, rejectUnauthorized: true,
        headers: {
          origin: this.origin, ...(cookie === '' ? {} : { cookie }),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
          ...options.headers,
        },
      }, (incoming) => {
        const chunks: Buffer[] = []
        let bytes = 0
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 1_048_576) {
            outgoing.destroy(new Error('Acceptance response exceeds its size limit'))
            return
          }
          chunks.push(chunk)
        })
        incoming.once('error', reject)
        incoming.once('end', () => {
          settle({ status: incoming.statusCode ?? 0, headers: incoming.headers, text: Buffer.concat(chunks).toString('utf8') })
        })
      })
      outgoing.once('error', reject)
      outgoing.setTimeout(15_000, () => { outgoing.destroy(new Error('Acceptance request timed out')) })
      outgoing.end(body)
    })
    const cookies = result.headers['set-cookie']
    if (Array.isArray(cookies)) {
      for (const value of cookies) await this.jar.setCookie(value, url.href)
    }
    return { status: result.status, headers: result.headers, body: result.text === '' ? null : JSON.parse(result.text) as unknown }
  }
}
