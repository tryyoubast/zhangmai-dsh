/** PostgreSQL regressions require explicit disposable-database credentials; no .env fallback or skip. */
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { postgresTestEnvironment } from './packages/identity/user-auth/tests-postgres/environment.ts'

postgresTestEnvironment()

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/identity/user-auth/tests-postgres/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 0,
  },
})
