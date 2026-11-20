/** Check the official model catalogue without generating tokens or exposing provider material. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Require HTTP 200 and the configured model; return only fixed diagnostics.
 * @param {object} options File, model, and optional request/deadline dependencies.
 * @param {string} options.secretFile The worker's mounted provider-key file.
 * @param {string} [options.model] Catalogue model id, defaulting to deepseek-chat.
 * @param {typeof globalThis.fetch} [options.fetch] Request implementation; tests supply a local stub.
 * @param {number} [options.timeoutMs] Whole request deadline, defaulting to 15000 milliseconds.
 * @returns {Promise<{ok: boolean, reason: string, status: number | null, modelPresent: boolean | null}>} Sanitized result without key, body, or error details.
 */
export async function checkProvider({ secretFile, model = 'deepseek-chat', fetch: request = globalThis.fetch, timeoutMs = 15_000 }) {
  let key
  try {
    key = (await readFile(secretFile, 'utf8')).trim()
  } catch {
    // Missing and unreadable files share a fixed diagnostic; filesystem errors may include sensitive material.
    return { ok: false, reason: 'key-unavailable', status: null, modelPresent: null }
  }
  if (key === '') return { ok: false, reason: 'key-empty', status: null, modelPresent: null }

  const signal = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await request('https://api.deepseek.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` }, signal, redirect: 'error',
    })
  } catch {
    // Transport exceptions can contain authorization headers or provider bodies.
    return { ok: false, reason: signal.aborted ? 'timeout' : 'request-failed', status: null, modelPresent: null }
  }
  if (response.status !== 200) return { ok: false, reason: 'http-status', status: response.status, modelPresent: null }
  let catalogue
  try {
    catalogue = await response.json()
  } catch {
    // Keep malformed response text and body-read errors out of both CLI and acceptance evidence.
    return { ok: false, reason: signal.aborted ? 'timeout' : 'invalid-catalogue', status: 200, modelPresent: null }
  }
  if (catalogue === null || typeof catalogue !== 'object' || !Array.isArray(catalogue.data)
    || !catalogue.data.every(item => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '')) {
    return { ok: false, reason: 'invalid-catalogue', status: 200, modelPresent: null }
  }
  const modelPresent = catalogue.data.some(item => item.id === model)
  return { ok: modelPresent, reason: modelPresent ? 'passed' : 'model-missing', status: 200, modelPresent }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkProvider({
    secretFile: join(process.env.DSH_NOVEL_SECRET_DIRECTORY ?? '/run/secrets', 'deepseek-api-key'),
    model: process.env.DSH_NOVEL_PROVIDER_MODEL ?? 'deepseek-chat',
  })
  if (result.ok) console.log(JSON.stringify(result))
  else {
    console.error(JSON.stringify(result))
    process.exitCode = 1
  }
}
