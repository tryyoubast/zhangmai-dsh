/** Novel worker regressions require separate disposable worker and migrator credentials without .env fallback. */
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { postgresTestEnvironment } from './packages/identity/user-auth/tests-postgres/environment.ts'

postgresTestEnvironment()

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: [
      'packages/storage/novel-authoring/tests-postgres/context-retrieval.spec.ts',
      'packages/storage/novel-authoring/tests-postgres/queued-claim.spec.ts',
      'packages/storage/novel-authoring/tests-postgres/worker-identity.spec.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 0,
  },
})
