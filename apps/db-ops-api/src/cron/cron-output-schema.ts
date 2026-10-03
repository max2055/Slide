/** Early Cron configs persisted a field-to-schema map rather than a root schema. */
export function normalizeCronOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const rootKeywords = ['type', 'properties', '$schema', '$ref', 'required', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'items', 'enum', 'const', 'additionalProperties'];
  if (rootKeywords.some(key => key in schema) || Object.keys(schema).length === 0) return schema;
  return { type: 'object', properties: schema, required: Object.keys(schema) };
}
