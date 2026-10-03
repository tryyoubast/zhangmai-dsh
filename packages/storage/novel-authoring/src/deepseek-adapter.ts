import type { NovelGenerationAdapter, NovelGenerationAdapterInput, NovelGenerationAdapterResult } from './generation.ts'

/** Configuration for the provider-neutral DeepSeek structured-output adapter. */
export interface DeepSeekNovelGenerationAdapterOptions {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly model?: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly maxContextExcerptChars?: number
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertStructuredDraft(value: unknown): NovelGenerationAdapterResult {
  if (!isRecord(value)) throw new Error('DeepSeek generation response must be a JSON object')
  const read = (name: 'records' | 'proposals'): readonly JsonRecord[] => {
    const valueForName = value[name]
    if (valueForName === undefined) return []
    if (!Array.isArray(valueForName) || valueForName.some(item => !isRecord(item))) {
      throw new Error(`DeepSeek generation ${name} must be an array of objects`)
    }
    return valueForName
  }
  const records = read('records')
  const proposals = read('proposals')
  if (records.length === 0 && proposals.length === 0) {
    throw new Error('DeepSeek generation response must contain records or proposals')
  }
  return { records, proposals }
}

function asJsonContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecord)
      .map(item => item.text)
      .filter((item): item is string => typeof item === 'string')
      .join('')
    if (text !== '') return text
  }
  throw new Error('DeepSeek generation response did not contain JSON content')
}

/**
 * Fetch-based DeepSeek adapter for novel draft generation.
 *
 * It deliberately returns structured data only. Domain validation, draft-only
 * enforcement, persistence, and publication remain owned by the authoring
 * services.
 */
export class DeepSeekNovelGenerationAdapter implements NovelGenerationAdapter {
  private readonly fetcher: typeof globalThis.fetch
  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxContextExcerptChars: number

  constructor(private readonly options: DeepSeekNovelGenerationAdapterOptions) {
    if (options.apiKey.trim() === '') throw new Error('DeepSeek API key is required')
    this.fetcher = options.fetch ?? globalThis.fetch
    if (typeof this.fetcher !== 'function') throw new Error('fetch is required for the DeepSeek generation adapter')
    this.baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/u, '')
    this.model = options.model ?? 'deepseek-chat'
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxContextExcerptChars = options.maxContextExcerptChars ?? 8_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer')
    if (!Number.isSafeInteger(this.maxContextExcerptChars) || this.maxContextExcerptChars <= 0) {
      throw new Error('maxContextExcerptChars must be a positive integer')
    }
  }

  /** Generate structured draft records through the configured DeepSeek endpoint. */
  async generate(input: NovelGenerationAdapterInput): Promise<NovelGenerationAdapterResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Return only a JSON object with records and/or proposals. Use fixed target types, draft status only, and never return SQL, DDL, queries, migrations, credentials, or publication commands.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                instruction: input.instruction,
                workspaceId: input.workspaceId,
                novelId: input.novelId,
                generationRunId: input.generationRunId,
                idempotencyKey: input.idempotencyKey,
                context: input.context.map(candidate => ({
                  sourceType: candidate.sourceType,
                  sourceId: candidate.sourceId,
                  status: candidate.status,
                  excerptHash: candidate.excerptHash,
                  tokenCount: candidate.tokenCount,
                  excerpt: candidate.excerpt?.slice(0, this.maxContextExcerptChars),
                })),
              }),
            },
          ],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`DeepSeek generation request failed with HTTP ${response.status}`)
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new Error('DeepSeek generation response was not valid JSON')
      }
      if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
        throw new Error('DeepSeek generation response did not contain a completion')
      }
      const message = payload.choices[0].message
      if (!isRecord(message)) throw new Error('DeepSeek generation response did not contain a message')
      let decoded: unknown
      try {
        decoded = JSON.parse(asJsonContent(message.content)) as unknown
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('DeepSeek generation content was not valid JSON')
        throw error
      }
      return assertStructuredDraft(decoded)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('DeepSeek generation request timed out')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
