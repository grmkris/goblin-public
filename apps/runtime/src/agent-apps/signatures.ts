import type { JobView } from './jobs.ts'
import type { Manifest } from './manifest.ts'

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A schema as a short type: `string`, `integer[]`, `"a" | "b"`, `{ title: string }`; nested objects two deep. */
function typeOf(schema: unknown, depth: number): string {
  if (!isObject(schema)) return 'unknown'
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((option) => typeOf(option, depth + 1)).join(' | ')
  if (schema.type === 'array') return `${typeOf(schema.items, depth + 1)}[]`
  if (schema.type === 'object' && isObject(schema.properties))
    return depth < 2 ? `{ ${fields(schema, depth + 1)} }` : 'object'
  return typeof schema.type === 'string' ? schema.type : 'unknown'
}

/** An input schema's fields with their types; an optional one ends in `?`. */
function fields(schema: Readonly<Record<string, unknown>>, depth = 0): string {
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const properties = isObject(schema.properties) ? Object.entries(schema.properties) : []
  return properties
    .map(([name, field]) => `${name}${required.has(name) ? '' : '?'}: ${typeOf(field, depth)}`)
    .join(', ')
}

/** One line per member: `name(input fields)`, and a view's output type after `→`, called with `app_call`. */
export function signatures(manifest: Manifest): string {
  const actions = Object.entries(manifest.actions).map(
    ([name, action]) => `${name}(${fields(action.input)})${action.agent ? '' : ' [UI only]'}`,
  )
  const views = Object.entries(manifest.views).map(
    ([name, view]) =>
      `${name}(${fields(view.input)})${view.output === undefined ? '' : ` → ${typeOf(view.output, 0)}`}`,
  )
  return [
    actions.length > 0 ? `actions ${actions.join(', ')}` : '',
    views.length > 0 ? `views ${views.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
}

/** An app's schedules for the model: each action, how often, and how its last run went or why it is paused. */
export function schedulesText(jobs: readonly JobView[]): string {
  if (jobs.length === 0) return ''
  const each = jobs.map((job) => {
    const when = `${job.action} every ${job.every}${job.at === null ? '' : ` at ${job.at} UTC`}`
    if (job.paused !== null) return `${when} (paused by ${job.paused === 'owner' ? 'the owner' : 'failures'})`
    return job.status === null ? when : `${when} (last run ${job.status})`
  })
  return ` Schedules: ${each.join(', ')}.`
}
