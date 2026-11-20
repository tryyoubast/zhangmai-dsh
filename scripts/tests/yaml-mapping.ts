export function yamlMapping(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected YAML mapping')
  return value as Record<string, unknown>
}
