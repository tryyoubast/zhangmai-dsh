/** Manage the isolated local Compose project; never removes volumes without an explicit reset. */
import { spawn } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withAcceptanceLock } from './real-budget.ts'

const directory = fileURLToPath(new URL('.', import.meta.url))
const docker = process.platform === 'win32' && existsSync('C:/Program Files/Docker/Docker/resources/bin/docker.exe')
  ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker'
const args = process.argv.slice(2)
const operation = args[0]
const stateOption = args.indexOf('--state-dir')
const state = resolve(stateOption === -1 ? join(directory, '.local') : args[stateOption + 1] ?? '')

async function writeOnce(path, value) {
  try {
    await writeFile(path, value, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

async function initialize() {
  await mkdir(join(state, 'secrets'), { recursive: true, mode: 0o700 })
  await mkdir(join(state, 'evidence'), { recursive: true, mode: 0o700 })
  for (const name of ['postgres', 'migrator', 'auth', 'app', 'worker', 'service', 'refresh-auth', 'refresh-migrator', 'redis']) {
    await writeOnce(join(state, 'secrets', `${name}-password`), randomBytes(32).toString('hex'))
  }
  const privateFile = join(state, 'secrets', 'access-private.pem')
  try {
    await readFile(privateFile)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    await writeOnce(privateFile, keys.privateKey)
  }
  const privateKey = await readFile(privateFile)
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  await writeOnce(join(state, 'secrets', 'access-public.pem'), publicKey)
  if ((await readFile(join(state, 'secrets', 'access-public.pem'), 'utf8')) !== publicKey) {
    throw new Error('Existing local access-token key pair does not match; initialization preserved both files')
  }
  await writeOnce(join(state, 'secrets', 'deepseek-api-key'), '')
  for (const profile of ['novel-api', 'novel-worker']) {
    const location = join(state, 'home', 'profiles', profile)
    await mkdir(location, { recursive: true, mode: 0o700 })
    await writeOnce(join(location, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-novel-app'], patchReload: 'startup' } },
    }, null, 2) + '\n')
  }
  console.log('Initialized isolated local staging materials. Existing secrets and profiles are preserved.')
}

function execute(command, arguments_, capture = false) {
  return new Promise((settle, reject) => {
    const child = spawn(command, arguments_, {
      cwd: resolve(directory, '../..'),
      env: {
        ...process.env,
        DSH_NOVEL_PROVIDER_URL: 'http://model:8081/v1',
        DSH_LOCAL_STATE: state,
        DSH_LOCAL_UID: String(process.getuid?.() ?? 1000),
        DSH_LOCAL_GID: String(process.getgid?.() ?? 1000),
      },
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) settle(output)
      else reject(new Error(`${command} exited ${String(code)}`))
    })
  })
}

const compose = (...arguments_) => execute(docker, ['compose', '--project-name', 'dsh-local-test', '--env-file', join(directory, 'images.lock.env'), '--file', join(directory, 'compose.yml'), ...arguments_])

async function preflight() {
  try {
    const info = JSON.parse(await execute(docker, ['info', '--format', '{{json .}}'], true))
    if (info.OSType !== 'linux') throw new Error('Docker must run Linux containers')
    await execute(docker, ['compose', 'version'])
  } catch (cause) {
    throw new Error('Docker Desktop with a running Linux container engine and Compose v2 is required.', { cause })
  }
}

async function main() {
  const flags = args.slice(1)
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]
    if (flag === '--state-dir' && index + 1 === stateOption && flags[index + 1] && !flags[index + 1].startsWith('--')) {
      index++
      continue
    }
    if (flag === '--confirm=dsh-local-test' && operation === 'reset') continue
    if (flag === '--resume' || flag === '--supplement') {
      if (operation !== 'test:real') throw new Error(`${flag} is only supported for test:real`)
      if (flags.indexOf(flag) !== index) throw new Error(`${flag} may only be supplied once`)
      continue
    }
    throw new Error('Unrecognized local staging option')
  }
  if (operation === 'init') return initialize()
  if (operation === 'reset' && !args.includes('--confirm=dsh-local-test')) {
    throw new Error('Reset destroys only dsh-local-test volumes. Repeat with --confirm=dsh-local-test to authorize it.')
  }
  if (!['up', 'down', 'reset', 'test', 'test:real', 'postgres', 'restart', 'check:provider'].includes(operation)) {
    throw new Error('Expected init, up, test, test:real, check:provider, postgres, restart, down, or reset --confirm=dsh-local-test')
  }
  await preflight()
  if (operation === 'check:provider') {
    let keyPath = join(state, 'secrets', 'deepseek-api-key')
    let modifiedAt = 'unavailable'
    try {
      keyPath = await realpath(keyPath)
      modifiedAt = (await stat(keyPath)).mtime.toISOString()
    } catch {
      // Missing or unreadable metadata is reported without filesystem exception details.
    }
    console.log(JSON.stringify({ keyPath, modifiedAt }))
    return compose('run', '--rm', '--no-deps', 'provider-check')
  }
  if (operation === 'postgres') {
    await compose('run', '--rm', 'regression')
    await compose('run', '--rm', 'staging-regression')
    return compose('run', '--rm', 'upgrade-regression')
  }
  if (['up', 'down', 'reset', 'restart'].includes(operation)) return withAcceptanceLock(state, manageServices)
  const realFlags = operation === 'test:real' ? ['--real', ...flags.filter(flag => flag === '--resume' || flag === '--supplement')] : []
  await execute(process.execPath, ['--import', 'tsx/esm', join(directory, 'acceptance.ts'), '--state-dir', state, ...realFlags])
}

async function manageServices() {
  if (operation === 'down') return compose('down', '--remove-orphans')
  if (operation === 'reset') return compose('down', '--volumes', '--remove-orphans')
  if (operation === 'restart') return compose('restart', 'api', 'worker')
  if (operation === 'up') {
    await initialize()
    await compose('build', 'provision', 'api', 'worker')
    await compose('up', '--detach', '--wait', 'postgres', 'redis', 'mailpit', 'model')
    // Schema upgrades run with both consumers stopped so old code cannot write during migration.
    await compose('stop', 'api', 'worker')
    await compose('run', '--rm', 'provision')
    // Cold profiles share the module fallback directory; finish its first writer before starting the worker.
    await compose('up', '--detach', '--wait', 'api', 'caddy')
    await compose('up', '--detach', '--wait', 'worker')
    await compose('cp', 'caddy:/data/caddy/pki/authorities/local/root.crt', join(state, 'local-ca.crt'))
    const images = await execute(docker, ['compose', '--project-name', 'dsh-local-test', '--env-file', join(directory, 'images.lock.env'), '--file', join(directory, 'compose.yml'), 'images', '--format', 'json'], true)
    await writeFile(join(state, 'evidence', 'images.json'), images)
    console.log('Local staging: https://localhost:8443; Mailpit: http://127.0.0.1:8025')
    return
  }
}

try {
  await main()
} catch (error) {
  // Credentials can occur in child exceptions: print only our operation label, never stack/cause or connection strings.
  console.error(error instanceof Error ? error.message : 'Local staging operation failed')
  process.exitCode = 1
}
