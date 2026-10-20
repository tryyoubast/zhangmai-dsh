import { defineConfig } from 'drizzle-kit'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMigrationDatabaseUrl } from './src/config.ts'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))

const databaseUrl = resolveMigrationDatabaseUrl()

export default defineConfig({
  schema: resolve(packageRoot, 'src/schema.ts'),
  out: resolve(packageRoot, 'migrations'),
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
})
