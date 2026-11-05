import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/build-preview-cloudflare.yml'), 'utf8')) as {
  on: unknown
  permissions: Record<string, string>
  concurrency: Record<string, unknown>
  env: Record<string, string>
  jobs: Record<string, {
    name?: string
    'runs-on'?: string
    needs?: string | string[]
    if?: string
    permissions?: Record<string, string>
    env?: Record<string, string>
    steps: Array<{ name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }>
  }>
}
const preview = workflow.jobs.preview
const deploy = workflow.jobs.deploy
if (preview === undefined || deploy === undefined) {
  throw new TypeError('Preview workflow must define preview and deploy jobs')
}

describe('PR preview workflow', () => {
  it('runs build validation by default with least privileges and reports no deployment', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['preview', 'deploy'])
    expect(preview.name).toBe('cloudflare pages preview')
    expect(preview['runs-on']).toBe('ubuntu-24.04')
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(preview.permissions).toEqual({ contents: 'read' })
    expect(preview.steps.find(step => step.uses === 'actions/checkout@v6')?.with).toEqual({ 'persist-credentials': false })
    expect(deploy.if).toBe("${{ vars.DSH_PREVIEW_DEPLOY_ENABLED == 'true' && github.event.pull_request.head.repo.full_name == github.repository }}")
    expect(JSON.stringify(preview)).not.toContain('secrets.')
    expect(JSON.stringify(preview)).not.toContain('pull-requests')
    const report = preview.steps.find(step => step.name === 'Report build-only validation')!
    expect(report.if).toBe("${{ vars.DSH_PREVIEW_DEPLOY_ENABLED != 'true' || github.event.pull_request.head.repo.full_name != github.repository }}")
    expect(report.run).toContain('validated build only')
    expect(report.run).toContain('no preview was deployed')
  })

  it('keeps the immutable full build and restore-only dependency cache', () => {
    expect(workflow.env.PRIMARY_NODE_VERSION).toBe('24')
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    const commands = preview.steps.map(step => step.run)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    expect(commands).toContain('pnpm run build')
    expect(commands).toContain('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview')
    expect(commands.indexOf('pnpm install --frozen-lockfile')).toBeLessThan(commands.indexOf('pnpm run build'))
    expect(commands.indexOf('pnpm run build')).toBeLessThan(commands.indexOf('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview'))
    expect(preview.steps.filter(step => step.uses?.startsWith('actions/cache'))).toHaveLength(1)
    expect(preview.steps.find(step => step.uses === 'actions/cache/restore@v4')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
  })

  it('gates deployment on the successful build and validates all required configuration first', () => {
    expect(deploy.needs).toBe('preview')
    expect(deploy['runs-on']).toBe('ubuntu-24.04')
    expect(deploy.permissions).toEqual({ 'pull-requests': 'write' })
    expect(deploy.env?.CF_PROJECT).toBe('${{ vars.DSH_PREVIEW_CF_PROJECT }}')
    const validate = deploy.steps[0]
    if (validate === undefined) throw new TypeError('Deploy job must start with configuration validation')
    expect(validate.name).toBe('Validate deployment configuration')
    expect(validate.env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
      CF_ACCESS_CLIENT_ID: '${{ secrets.CF_ACCESS_CLIENT_ID }}',
      CF_ACCESS_CLIENT_SECRET: '${{ secrets.CF_ACCESS_CLIENT_SECRET }}',
    })
    const validationScript = validate.run?.match(/^node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\nNODE\s*$/)?.[1]
    expect(validationScript).toBeDefined()

    const validEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CF_PROJECT: 'preview-project',
      CLOUDFLARE_API_TOKEN: 'api-token',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CF_ACCESS_CLIENT_ID: 'access-client-id',
      CF_ACCESS_CLIENT_SECRET: 'access-client-secret',
    }
    const runValidation = (env: NodeJS.ProcessEnv) => spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', validationScript ?? ''],
      { env, encoding: 'utf8' },
    )
    expect(runValidation(validEnvironment).status).toBe(0)

    const requiredConfig = [
      ['CF_PROJECT', 'DSH_PREVIEW_CF_PROJECT'],
      ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN'],
      ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID'],
      ['CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_ID'],
      ['CF_ACCESS_CLIENT_SECRET', 'CF_ACCESS_CLIENT_SECRET'],
    ] as const
    for (const [variable, diagnostic] of requiredConfig) {
      const missingEnvironment = { ...validEnvironment }
      missingEnvironment[variable] = ''
      const result = runValidation(missingEnvironment)
      expect(result.status, `${variable} should fail validation`).toBe(1)
      expect(result.stderr, `${variable} should identify the missing config`).toContain(diagnostic)
    }
  })

  it('fails before downloading or deploying when deployment configuration is missing', () => {
    const validateIndex = deploy.steps.findIndex(step => step.name === 'Validate deployment configuration')
    const downloadIndex = deploy.steps.findIndex(step => step.uses === 'actions/download-artifact@v8')
    const uploadIndex = deploy.steps.findIndex(step => step.name === 'Upload to Cloudflare Pages')
    expect(validateIndex).toBe(0)
    expect(downloadIndex).toBeGreaterThan(validateIndex)
    expect(uploadIndex).toBeGreaterThan(validateIndex)
  })

  it('transfers only the shaped static build and retains protected verification and idempotent URL comments', () => {
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
    const shape = preview.steps.find(step => step.name === 'Shape the upload')!
    expect(shape.run).toContain("find apps/web/dist -name '*.map' -delete")
    expect(shape.run).toContain('cp apps/web/dist/preview.html apps/web/dist/index.html')
    const artifact = preview.steps.find(step => step.uses === 'actions/upload-artifact@v7')!
    expect(artifact.with).toEqual({ name: 'preview-static-build', path: 'apps/web/dist', 'if-no-files-found': 'error' })
    const download = deploy.steps.find(step => step.uses === 'actions/download-artifact@v8')!
    expect(download.with).toEqual({ name: 'preview-static-build', path: 'apps/web/dist' })
    const upload = deploy.steps.find(step => step.name === 'Upload to Cloudflare Pages')!
    expect(upload.run).toContain('npx --yes wrangler@4 pages deploy apps/web/dist')
    expect(upload.run).toContain('--project-name "$CF_PROJECT"')
    expect(upload.run).toContain('--branch "pr-${{ github.event.pull_request.number }}"')
    expect(upload.env?.CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(upload.env?.CLOUDFLARE_ACCOUNT_ID).toBe('${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    const verify = deploy.steps.find(step => step.name === 'Verify the protected deployment serves the image')!
    expect(verify.run).toContain('/preview/vfs-image.tar.gz')
    expect(verify.run).toContain('"$code" != "200"')
    expect(verify.run).toContain('content-encoding:')
    expect(verify.run).toContain('"$magic" != "1f8b"')
    expect(verify.env?.CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    const comment = deploy.steps.find(step => step.name === 'Comment the preview URL')!
    expect(comment.run).toContain('<!-- dsh-preview-url -->')
    expect(comment.run).toContain('gh pr comment "$PR" --body-file -')
    expect(comment.run).toContain('if [ -n "$existing" ]')
    expect(comment.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
    expect(comment.env?.GH_REPO).toBe('${{ github.repository }}')
  })
})
