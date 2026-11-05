import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    name: 'postgres',
    include: ['packages/identity/user-auth/tests-postgres/**/*.spec.ts'],
    pool: 'forks',
    execArgv: vitestExecArgv,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
