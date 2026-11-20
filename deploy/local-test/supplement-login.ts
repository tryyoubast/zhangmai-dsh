/** Keep cross-process staging login material outside Git, reports and container mounts. */
import { spawnSync } from 'node:child_process'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Login = { readonly email: string; readonly password: string }

function pathFor(state: string, userId: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(userId)) throw new Error('Supplemental login requires a test user UUID')
  return join(state, 'secrets', `supplement-login-${userId}`)
}

function windowsSecret(value: string, encrypt: boolean): string {
  const convert = encrypt
    ? '$text = [Console]::In.ReadToEnd(); ConvertTo-SecureString $text -AsPlainText -Force | ConvertFrom-SecureString'
    : '$secure = [Console]::In.ReadToEnd() | ConvertTo-SecureString; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }'
  const command = Buffer.from(`$ErrorActionPreference = 'Stop'; ${convert}`, 'utf16le').toString('base64')
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    // Windows PowerShell must use its own Security module even when launched from PowerShell 7.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000,
  })
  if (child.status !== 0 || child.stdout.trim() === '') throw new Error('Windows user-scoped secret protection failed')
  return child.stdout.trim()
}

/** Persist a one-off user's login before the first reservation, using DPAPI on Windows.
 * @param state - Existing local staging state outside the checkout.
 * @param userId - Fixture user UUID, which also identifies the secret file.
 * @param login - Test account login, never emitted in evidence.
 */
export async function saveSupplementLogin(state: string, userId: string, login: Login): Promise<void> {
  const payload = JSON.stringify({ email: login.email, password: login.password })
  const stored = process.platform === 'win32' ? windowsSecret(payload, true) : payload
  await writeFile(pathFor(state, userId), stored, { flag: 'wx', mode: 0o600 })
}

/** Read the original test owner's login without reusing any session token.
 * @param state - Existing local staging state outside the checkout.
 * @param userId - Fixture user UUID from the verified checkpoint.
 * @returns The login for a fresh HTTPS authentication.
 */
export async function readSupplementLogin(state: string, userId: string): Promise<Login> {
  const path = pathFor(state, userId)
  const info = await lstat(path)
  if (!info.isFile() || process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('Supplemental test login file is not private')
  }
  const stored = await readFile(path, 'utf8')
  const value: unknown = JSON.parse(process.platform === 'win32' ? windowsSecret(stored, false) : stored)
  if (value === null || typeof value !== 'object' || !('email' in value) || typeof value.email !== 'string'
    || !/^staging-[a-f0-9-]{36}@test\.invalid$/iu.test(value.email) || !('password' in value)
    || typeof value.password !== 'string' || !/^A!9[a-f0-9]{48}$/u.test(value.password)) {
    throw new Error('Supplemental test login file is malformed')
  }
  return { email: value.email, password: value.password }
}
