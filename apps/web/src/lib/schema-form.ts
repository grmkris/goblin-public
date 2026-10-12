// A form for a JSON Schema's flat object (ADR 0041): what an event's input schema asks, as fields the owner fills in,
// and the exact-match filters those fields make. A nullable property (`["string", "null"]`, or `anyOf` one type and
// null) is a plain optional field. A schema with anything a flat form cannot hold (a nested object, a list of objects,
// a union of types) has no fields: its form is raw JSON. The schema is the server's, untrusted: only its property names,
// types, enums, defaults and words are read, and the words are shown as text.
import { Option, Predicate, Schema } from 'effect'

type Json = typeof Schema.Json.Type

/**
 * What every field has: the property it fills, how it reads, whether the schema requires it, whether it takes null
 * (left empty, a required one sends null), and the server's default in words, when it has one.
 */
type FieldBase = {
  readonly name: string
  readonly title: string
  readonly description?: string
  readonly required: boolean
  readonly nullable: boolean
  readonly fallback?: string
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
const Type = Schema.Literals(['string', 'number', 'integer', 'boolean', 'array'])
/** What one property's schema (or one member of its `anyOf`) says that a field reads. */
const Shape = Schema.Struct({
  type: Schema.optional(Schema.Union([Type, Schema.Literal('null'), Schema.Array(Schema.String)])),
  enum: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
  items: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
})
const property = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Shape.fields,
    anyOf: Schema.optional(Schema.Array(Shape)),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    default: Schema.optional(Schema.Json),
  }),
)
const isType = Schema.is(Type)

type Shape = typeof Shape.Type
/** A shape's own type with null set apart: none when it takes more than one type besides null, or one no field holds. */
type Typed = { readonly type: typeof Type.Type | 'null' | undefined; readonly nullable: boolean }
function typeOf(shape: Shape): Typed | undefined {
  if (shape.type === undefined) return { type: undefined, nullable: false }
  const types = typeof shape.type === 'string' ? [shape.type] : shape.type
  const others = types.filter((type) => type !== 'null')
  if (others.length === 0) return { type: 'null', nullable: true }
  const [type] = others
  if (others.length !== 1 || type === undefined || !isType(type)) return undefined
  return { type, nullable: others.length < types.length }
}

/** What a field is drawn from: the shape it holds, its type, and whether it also takes null. */
type Held = { readonly shape: Shape; readonly type: typeof Type.Type | undefined; readonly nullable: boolean }

/**
 * The one shape a property holds: its own, or, for `anyOf` of one shape and null, that shape, which then takes null.
 * None for anything else: null alone, or a union of types a flat form cannot hold.
 */
function shapeOf(read: Shape & { readonly anyOf?: readonly Shape[] | undefined }): Held | undefined {
  const members = read.anyOf ?? [read]
  let held: Held | undefined
  let nullable = false
  for (const member of members) {
    const typed = typeOf(member)
    if (typed === undefined) return undefined
    nullable ||= typed.nullable
    if (typed.type === 'null') continue
    if (held !== undefined) return undefined
    held = { shape: member, type: typed.type, nullable: false }
  }
  return held === undefined ? undefined : { ...held, nullable }
}

const words = (text: string | undefined): string | undefined =>
  text === undefined || text.trim() === '' ? undefined : text.trim().slice(0, WORDS)

/** The server's default for a field, in words; none when it gives none, or null. */
function fallbackOf(value: typeof Schema.Json.Type | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (Predicate.isBoolean(value)) return value ? 'Yes' : 'No'
  if (Array.isArray(value) && value.every(Predicate.isString)) return words(value.join(', '))
  return Predicate.isString(value) || Predicate.isNumber(value) ? words(String(value)) : undefined
}

/** The field one property makes, or none when a flat form cannot hold it. */
function fieldOf(name: string, schema: unknown, required: boolean): FormField | undefined {
  const read = Option.getOrUndefined(property(schema))
  const held = read === undefined ? undefined : shapeOf(read)
  if (read === undefined || held === undefined) return undefined
  const { shape, type, nullable } = held
  const description = words(read.description)
  const fallback = fallbackOf(read.default)
  const base = {
    name,
    title: words(read.title) ?? name,
    required,
    nullable,
    ...(description === undefined ? {} : { description }),
    ...(fallback === undefined ? {} : { fallback }),
  }
  const options = (shape.enum ?? []).filter(Predicate.isString)
  if (options.length > 0) return { ...base, kind: 'choice', options }
  return fieldOfType(base, type, shape.items?.type)
}

/** The field of one type: text, a number, yes or no, or a list of texts; none for any other. */
function fieldOfType(
  base: FieldBase,
  type: typeof Type.Type | undefined,
  items: string | undefined,
): FormField | undefined {
  if (type === 'string') return { ...base, kind: 'text' }
  if (type === 'number' || type === 'integer') return { ...base, kind: 'number', integer: type === 'integer' }
  if (type === 'boolean') return { ...base, kind: 'boolean' }
  if (type === 'array' && items === 'string') return { ...base, kind: 'list' }
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
 * number that is not one, a field the schema requires left empty). A required field that takes null sends null when it
 * is left empty.
 */
export function formValue(fieldsShown: readonly FormField[], inputs: FormInputs): FormResult {
  const value: Record<string, Json> = {}
  for (const field of fieldsShown) {
    const made = valueOf(field, inputs[field.name] ?? '')
    if (Predicate.isObject(made) && 'problem' in made) return made
    if (made !== undefined) value[field.name] = made
    else if (field.required && field.nullable) value[field.name] = null
    else if (field.required) return { problem: `${field.title} is needed: the server asks for it.` }
  }
  return { value }
}

/** What one filter shows as in its field; none when the field cannot show it. Null shows as empty where it is taken. */
function inputOf(field: FormField, value: unknown): string | undefined {
  if (value === null) return field.nullable ? '' : undefined
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
