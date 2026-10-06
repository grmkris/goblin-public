import * as Schema from 'effect/Schema'
import { AppError, toAppError } from '../http/errors.ts'

/** A schema as the MCP SDK's Standard Schema with JSON Schema, for a tool's input or output. */
export const standard = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

/** A result as one JSON text block. */
export const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

const encodeError = Schema.encodeSync(AppError)

/** A failure as the tool's result: the error's tag and fields, never a stack or a foreign message. */
export const failed = (cause: unknown) => ({ isError: true, ...text(encodeError(toAppError(cause))) })
