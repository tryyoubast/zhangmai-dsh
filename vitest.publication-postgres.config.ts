/** Publication regressions always use explicit restricted disposable PostgreSQL credentials. */
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { postgresTestEnvironment } from './packages/identity/user-auth/tests-postgres/environment.ts'

postgresTestEnvironment()

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/storage/novel-authoring/tests-postgres/publication*.spec.ts'],
    exclude: ['packages/storage/novel-authoring/tests-postgres/publication-upgrade.spec.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    retry: 0,
  },
})
