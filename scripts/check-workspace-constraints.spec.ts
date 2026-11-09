/** Experimental-package publication and dependency constraints. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkDshFamilyVersion,
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspaceManifest,
  expectedDshPackageFiles,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

const publicExperimental: WorkspaceManifest = {
  dir: 'packages/experimental/agent-team',
  manifest: {
    name: '@deepseek-ai/dsh-experimental-agent-team',
    publishConfig: { access: 'public' },
  },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it('requires public metadata only for the Agent Teams exceptions', () => {
    expect(checkExperimentalManifest(publicExperimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...publicExperimental,
      manifest: {
        name: '@deepseek-ai/dsh-experimental-agent-team',
        private: true,
      },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-agent-team: public experimental package must not set "private": true',
      '@deepseek-ai/dsh-experimental-agent-team: public experimental package must set publishConfig.access to "public"',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('dsh family version coherence', () => {
  it('rejects a package carrying a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh-http-proxy: package.json version must match root version 0.1.2-rc.1')
  })

  it('rejects the root-named CLI app on a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh: package.json version must match root version 0.1.2-rc.1')
  })

  it('accepts a manifest carrying the shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-rc.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
  })

  it('leaves other sequences to their own version lines', () => {
    expect(checkDshFamilyVersion({ name: '@deepseek-ai/cordis', version: '4.0.1' }, '0.1.2-rc.1')).toBeUndefined()
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/node-addon-system', version: '0.1.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
    expect(checkDshFamilyVersion({ version: '0.1.2-alpha.5' }, '0.1.2-rc.1')).toBeUndefined()
  })
})

describe('package payload constraints', () => {
  it('publishes only the database migration inputs and controlled scripts beside built artifacts', () => {
    const expected = [
      'lib/index.js',
      'migrations/*.sql',
      'migrations/meta/_journal.json',
      'scripts/migrate.js',
      'scripts/bootstrap-migrator-ownership.sql',
      'lib/types/**/*.d.ts',
    ]
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname,
      '../packages/database/database-postgres/package.json'), 'utf8')) as WorkspaceManifest['manifest']
    expect(expectedDshPackageFiles(manifest)).toEqual(expected)
    expect(manifest.files).toEqual(expected)
    expect(checkWorkspaceManifest({ dir: 'packages/database/database-postgres', manifest })).toEqual([])
    for (const extra of ['src', 'src/index.ts', 'lib/index.js.map', 'lib/types/index.d.ts.map',
      'migrations', 'migrations/**', 'scripts/**/*.js', 'scripts/**/*.sql', 'drizzle.config.ts']) {
      expect(checkWorkspaceManifest({
        dir: 'packages/database/database-postgres', manifest: { ...manifest, files: [...expected, extra] },
      }).some(error => error.includes('package.json files must'))).toBe(true)
    }
    expect(expectedDshPackageFiles({ name: '@deepseek-ai/dsh-other' })).toEqual([
      'lib/index.js', 'lib/types/**/*.d.ts',
    ])
  })

  it.each([
    'database/database-postgres', 'identity/user-auth', 'storage/novel-authoring', 'api/novel-authoring-http',
  ])('%s declares the shared Cordis peer and public repository metadata', (directory) => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname,
      '../packages/' + directory + '/package.json'), 'utf8')) as WorkspaceManifest['manifest']
    expect(manifest.peerDependencies?.['@deepseek-ai/cordis']).toBe('workspace:^')
    expect(manifest.devDependencies?.['@deepseek-ai/cordis']).toBe('workspace:^')
    expect(manifest.publishConfig).toEqual({ access: 'public' })
    expect(manifest.repository).toEqual({
      type: 'git', url: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
      directory: 'packages/' + directory,
    })
  })

  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })
})
