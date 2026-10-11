// A form for a JSON Schema's flat object (ADR 0041): what an event's input schema asks, as fields the owner fills in,
// and the exact-match filters those fields make. A schema with anything a flat form cannot hold (a nested object, a
// list of objects, a union) has no fields: its form is raw JSON. The schema is the server's, untrusted: only its
// property names, types, enums and words are read, and the words are shown as text.
import { Option, Predicate, Schema } from 'effect'

type Json = typeof Schema.Json.Type

/** What every field has: the property it fills, how it reads, and whether the schema requires it. */
type FieldBase = {
  readonly name: string
  readonly title: string
  readonly description?: string
  readonly required: boolean
}

/** One field a flat form draws: free text, one of a list, a number, yes or no, or a list of texts. */
export type FormField =
  | (FieldBase & { readonly kind: 'text' })
  | (FieldBase & { readonly kind: 'choice'; readonly options: readonly string[] })
  | (FieldBase & { readonly kind: 'number'; readonly integer: boolean })
  | (FieldBase & { readonly kind: 'boolean' })
  | (FieldBase & { readonly kind: 'list' })

/** What the owner typed or chose, by property: empty means "any". A yes-or-no field holds `true`, `false` or empty. */
export type FormInputs = Readonly<Record<string, string>>

/** The filters a form makes, or what to fix first. */
export type FormResult = { readonly value: Readonly<Record<string, Json>> } | { readonly problem: string }

/** How many fields a form draws at most; a schema with more is edited as JSON. */
const MOST_FIELDS = 24
/** How long a server's words for one field may be before they are cut. */
const WORDS = 200

const fields = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optional(Schema.Literal('object')),
    properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    required: Schema.optional(Schema.Array(Schema.String)),
  }),
)
const property = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optional(Schema.Literals(['string', 'number', 'integer', 'boolean', 'array'])),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    enum: Schema.optional(Schema.Array(Schema.String)),
    items: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
  }),
)

const words = (text: string | undefined): string | undefined =>
  text === undefined || text.trim() === '' ? undefined : text.trim().slice(0, WORDS)

/** The field one property makes, or none when a flat form cannot hold it. */
function fieldOf(name: string, schema: unknown, required: boolean): FormField | undefined {
  const read = Option.getOrUndefined(property(schema))
  if (read === undefined) return undefined
  const description = words(read.description)
  const base = {
    name,
    title: words(read.title) ?? name,
    required,
    ...(description === undefined ? {} : { description }),
  }
  if (read.enum !== undefined && read.enum.length > 0) return { ...base, kind: 'choice', options: read.enum }
  if (read.type === 'string') return { ...base, kind: 'text' }
  if (read.type === 'number' || read.type === 'integer')
    return { ...base, kind: 'number', integer: read.type === 'integer' }
  if (read.type === 'boolean') return { ...base, kind: 'boolean' }
  if (read.type === 'array' && read.items?.type === 'string') return { ...base, kind: 'list' }
  return undefined
}

/**
 * The fields of an object schema whose properties a flat form can hold, required ones first; none when one cannot be
 * held or there are too many, so the form is raw JSON. A schema with no properties has no fields: every event matches.
 */
export function formFields(schema: unknown): readonly FormField[] | undefined {
  const object = Option.getOrUndefined(fields(schema))
  if (object === undefined) return undefined
  const entries = Object.entries(object.properties ?? {})
  if (entries.length > MOST_FIELDS) return undefined
  const required = new Set(object.required ?? [])
  const made = entries.map(([name, each]) => fieldOf(name, each, required.has(name)))
  if (made.some((field) => field === undefined)) return undefined
  return made.filter(Predicate.isNotUndefined).toSorted((a, b) => Number(b.required) - Number(a.required))
}

/** One field's filter from what was typed, or what is wrong with it; none when it is left empty. */
function valueOf(field: FormField, input: string): Json | undefined | { readonly problem: string } {
  const typed = input.trim()
  if (typed === '') return undefined
  if (field.kind === 'boolean') return typed === 'true'
  if (field.kind === 'list')
    return typed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  if (field.kind !== 'number') return typed
  const number = Number(typed)
  if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number)))
    return { problem: `${field.title} must be ${field.integer ? 'a whole number' : 'a number'}.` }
  return number
}

/**
 * The filters the fields' inputs make: only what was filled in, each as its schema's type; or what to fix first (a
 * number that is not one, a field the schema requires left empty).
 */
export function formValue(fieldsShown: readonly FormField[], inputs: FormInputs): FormResult {
  const value: Record<string, Json> = {}
  for (const field of fieldsShown) {
    const made = valueOf(field, inputs[field.name] ?? '')
    if (Predicate.isObject(made) && 'problem' in made) return made
    if (made !== undefined) value[field.name] = made
    else if (field.required) return { problem: `${field.title} is needed: the server asks for it.` }
  }
  return { value }
}

/** What one filter shows as in its field; none when the field cannot show it. */
function inputOf(field: FormField, value: unknown): string | undefined {
  if (field.kind === 'boolean') return Predicate.isBoolean(value) ? String(value) : undefined
  if (field.kind === 'number') return Predicate.isNumber(value) ? String(value) : undefined
  if (field.kind === 'list')
    return Array.isArray(value) && value.every(Predicate.isString) ? value.join(', ') : undefined
  if (!Predicate.isString(value)) return undefined
  return field.kind === 'choice' && !field.options.includes(value) ? undefined : value
}

/** The inputs that show `value` in the fields; none when a filter has no field or its field cannot show it. */
export function formInputs(
  fieldsShown: readonly FormField[],
  value: Readonly<Record<string, unknown>>,
): FormInputs | undefined {
  const inputs: Record<string, string> = {}
  for (const [name, each] of Object.entries(value)) {
    const field = fieldsShown.find((candidate) => candidate.name === name)
    const input = field === undefined ? undefined : inputOf(field, each)
    if (input === undefined) return undefined
    inputs[name] = input
  }
  return inputs
}
