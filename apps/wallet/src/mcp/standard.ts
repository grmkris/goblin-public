import * as Schema from 'effect/Schema'

/** An Effect schema as the MCP SDK's Standard Schema with JSON Schema, for a tool's input. */
export const standard = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))
