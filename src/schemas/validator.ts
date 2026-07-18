import Ajv, { ErrorObject } from 'ajv';
import topicSchema from './topic.schema.json';
import metadataSchema from './metadata.schema.json';
import extractSchema from './extract.schema.json';
import scoreSchema from './score.schema.json';
import lineageSchema from './lineage.schema.json';
import relatedTopicsSchema from './related_topics.schema.json';

export type SchemaName = 'topic' | 'metadata' | 'extract' | 'score' | 'lineage' | 'related_topics';

const ajv = new Ajv({ allErrors: true });
const schemas: Record<SchemaName, object> = {
  topic: topicSchema,
  metadata: metadataSchema,
  extract: extractSchema,
  score: scoreSchema,
  lineage: lineageSchema,
  related_topics: relatedTopicsSchema,
};
const compiled = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)])
) as Record<SchemaName, ReturnType<Ajv['compile']>>;

export function validateAgainstSchema(schemaName: SchemaName, data: unknown): { valid: boolean; errors: string[] } {
  const validateFn = compiled[schemaName];
  const valid = validateFn(data) as boolean;
  const errors = (validateFn.errors ?? []).map((e: ErrorObject) => `${e.instancePath} ${e.message}`);
  return { valid, errors };
}
