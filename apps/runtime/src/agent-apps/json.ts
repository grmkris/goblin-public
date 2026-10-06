import { Compile } from 'typebox/compile'
import { InvalidInput, PayloadTooLarge } from '../http/errors.ts'

const encoder = new TextEncoder()

/** The size of a value as JSON, in bytes. */
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? 'null').byteLength

/**
 * `value` as JSON would carry it (no `undefined`, functions, class instances or cycles), refused when it is larger
 * than `limit` bytes.
 */
export function plainJson(value: unknown, limit: number, what: string): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    throw new InvalidInput({ reason: `${what} is not JSON` })
  }
  if (text === undefined) return null
  if (encoder.encode(text).byteLength > limit) throw new PayloadTooLarge({ limit })
  return JSON.parse(text)
}

type Validator = ReturnType<typeof Compile>
const compiled = new Map<string, Validator>()

/** Why `value` does not match `schema` (at most five reasons), or nothing when it does. */
export function mismatches(schema: unknown, value: unknown): readonly string[] {
  const key = JSON.stringify(schema)
  let validator = compiled.get(key)
  if (validator === undefined) {
    // SAFETY: the schema passed `schemaProblems`, so it is a JSON Schema of the keywords TypeBox compiles.
    validator = Compile(schema as Parameters<typeof Compile>[0])
    if (compiled.size > 500) compiled.clear()
    compiled.set(key, validator)
  }
  if (validator.Check(value)) return []
  return [...validator.Errors(value)]
    .slice(0, 5)
    .map((error) => `${error.instancePath === '' ? 'value' : error.instancePath}: ${error.message}`)
}

const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'description',
  'title',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The problems of the schema's own keywords: only the `s.*` subset, known types, string enums. */
function ownProblems(schema: Readonly<Record<string, unknown>>, where: string): string[] {
  const problems = Object.keys(schema)
    .filter((key) => !KEYWORDS.has(key))
    .map((key) => `${where}: "${key}" is not supported`)
  const type = schema.type
  if (type !== undefined && !(typeof type === 'string' && TYPES.has(type))) problems.push(`${where}: unknown type`)
  const values = schema.enum
  if (values !== undefined && !(Array.isArray(values) && values.every((value) => typeof value === 'string')))
    problems.push(`${where}: enum takes strings`)
  if (schema.properties !== undefined && !isRecord(schema.properties))
    problems.push(`${where}: properties must be an object`)
  return problems
}

/** The schemas nested in this one, each with where it is. */
function children(schema: Readonly<Record<string, unknown>>, where: string): [unknown, string][] {
  return [
    ...Object.entries(isRecord(schema.properties) ? schema.properties : {}).map(([key, inner]): [unknown, string] => [
      inner,
      `${where}.${key}`,
    ]),
    ...(schema.items === undefined ? [] : [[schema.items, `${where}[]`] satisfies [unknown, string]]),
    ...(isRecord(schema.additionalProperties)
      ? [[schema.additionalProperties, `${where}{}`] satisfies [unknown, string]]
      : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf.map((inner): [unknown, string] => [inner, `${where}|`]) : []),
  ]
}

/**
 * What is wrong with a schema an app declared: it must be the subset `s.*` builds (no `$ref`, patterns or formats),
 * so every schema is cheap to check and plain for a model to read as tool parameters.
 */
export function schemaProblems(schema: unknown, where: string, depth = 0): readonly string[] {
  if (depth > 12) return [`${where}: nested too deeply`]
  if (!isRecord(schema)) return [`${where}: not a schema (use s.object, s.string, …)`]
  return [
    ...ownProblems(schema, where),
    ...children(schema, where).flatMap(([inner, path]) => schemaProblems(inner, path, depth + 1)),
  ]
}
