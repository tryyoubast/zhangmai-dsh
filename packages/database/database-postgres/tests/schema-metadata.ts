import { is, SQL } from 'drizzle-orm'
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core'
import * as schema from '../src/schema.ts'

const dialect = new PgDialect()

function sqlValue(value: unknown): unknown {
  return is(value, SQL) ? dialect.sqlToQuery(value) : value
}

/**
 * Collect ordered columns and named constraints without Drizzle's cyclic table references.
 * @returns Schema metadata including rendered SQL expressions and bound values.
 */
export function schemaMetadata(): unknown {
  return Object.fromEntries(Object.entries(schema)
    .flatMap(([name, table]) => {
      if (!is(table, PgTable)) return []
      const config = getTableConfig(table)
      return [[name, {
        schema: config.schema,
        name: config.name,
        columns: config.columns.map(column => ({
          name: column.name,
          sqlType: column.getSQLType(),
          dataType: column.dataType,
          columnType: column.columnType,
          notNull: column.notNull,
          primary: column.primary,
          hasDefault: column.hasDefault,
          default: sqlValue(column.default),
          isUnique: column.isUnique,
          uniqueName: column.isUnique ? column.uniqueName : undefined,
          uniqueType: column.uniqueType,
          enumValues: column.enumValues,
          generated: column.generated,
          generatedIdentity: column.generatedIdentity,
        })),
        indexes: config.indexes.map(({ config: index }) => {
          const { table: _table, columns, where, ...options } = index
          return { ...options, columns: columns.map(sqlValue), where: sqlValue(where) }
        }),
        primaryKeys: config.primaryKeys.map(key => ({
          name: key.getName(),
          columns: key.columns.map(column => column.name),
        })),
        foreignKeys: config.foreignKeys.map((key) => {
          const reference = key.reference()
          const foreignTable = getTableConfig(reference.foreignTable)
          return {
            name: key.getName(),
            columns: reference.columns.map(column => column.name),
            foreignSchema: foreignTable.schema,
            foreignTable: foreignTable.name,
            foreignColumns: reference.foreignColumns.map(column => column.name),
            onUpdate: key.onUpdate,
            onDelete: key.onDelete,
          }
        }),
        uniqueConstraints: config.uniqueConstraints.map(key => ({
          name: key.getName(),
          columns: key.columns.map(column => column.name),
          nullsNotDistinct: key.nullsNotDistinct,
        })),
        checks: config.checks.map(check => ({ name: check.name, value: sqlValue(check.value) })),
        enableRLS: config.enableRLS,
        policies: config.policies,
      }]]
    }))
}
