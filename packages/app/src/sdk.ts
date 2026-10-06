// The server SDK of an agent app: the module an app's code imports as `@goblin/app` (ADR 0021). It builds JSON
// Schemas and returns the app's definition as written; the release entry reads that definition, and goblin's runtime
// checks every input and every state against the schemas.

/** A JSON Schema, as `s.*` builds it. */
export type JsonSchema = Readonly<Record<string, unknown>>

const OPTIONAL = 'x-goblin-optional'

const schema = (json: Record<string, unknown>): JsonSchema => Object.freeze(json)

const bounds = (min: number | undefined, max: number | undefined, low: string, high: string) => ({
  ...(min === undefined ? {} : { [low]: min }),
  ...(max === undefined ? {} : { [high]: max }),
})

/** Schema builders for state, action inputs and view inputs. */
export const s = {
  /** Text, optionally with a length range in characters. */
  string: (options: { readonly min?: number; readonly max?: number } = {}) =>
    schema({ type: 'string', ...bounds(options.min, options.max, 'minLength', 'maxLength') }),
  /** A number; `int` makes it a whole number. */
  number: (options: { readonly int?: boolean; readonly min?: number; readonly max?: number } = {}) =>
    schema({
      type: options.int === true ? 'integer' : 'number',
      ...bounds(options.min, options.max, 'minimum', 'maximum'),
    }),
  boolean: () => schema({ type: 'boolean' }),
  /** One of the given strings. */
  enum: (values: readonly string[]) => schema({ type: 'string', enum: [...values] }),
  /** A list of `items`, at most `max` long. */
  array: (items: JsonSchema, options: { readonly max?: number } = {}) =>
    schema({ type: 'array', items, ...bounds(undefined, options.max, 'minItems', 'maxItems') }),
  /** An object with exactly these properties; wrap one in `s.optional` to make it optional. */
  object: (properties: Readonly<Record<string, JsonSchema>>) =>
    schema({
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => {
          const { [OPTIONAL]: _optional, ...rest } = value
          return [key, rest]
        }),
      ),
      required: Object.entries(properties)
        .filter(([, value]) => value[OPTIONAL] !== true)
        .map(([key]) => key),
      additionalProperties: false,
    }),
  /** An object keyed by any string, each value `values` (a map from id to item, for example). */
  record: (values: JsonSchema) => schema({ type: 'object', additionalProperties: values }),
  /** A property `s.object` does not require. */
  optional: (inner: JsonSchema) => schema({ ...inner, [OPTIONAL]: true }),
  /** `inner` or `null`. */
  nullable: (inner: JsonSchema) => schema({ anyOf: [inner, { type: 'null' }] }),
}

/** Returns the app's definition unchanged; it exists so the definition reads as one. */
export function defineApp<T>(definition: T): T {
  return definition
}
