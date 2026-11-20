/** Workspace identity regressions require app-only and migrator-only credentials in one disposable database. */
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { postgresTestEnvironment } from './packages/identity/user-auth/tests-postgres/environment.ts'

postgresTestEnvironment()

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/storage/novel-authoring/tests-postgres/workspace-identity.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 0,
  },
})
