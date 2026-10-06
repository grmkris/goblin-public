import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { jsonBytes, mismatches, schemaProblems } from './json.ts'
import { APP_NAME, MEMBER_NAME } from './names.ts'

/** The most actions and views one app declares, and the largest schema of one. */
const MAX_MEMBERS = 12
const MAX_SCHEMA_BYTES = 16 * 1024

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Json = Schema.Record(Schema.String, Schema.Unknown)

const Action = Schema.Struct({
  description: Text(300),
  input: Json,
  agent: Schema.Boolean,
  prepare: Schema.Boolean,
  run: Schema.Boolean,
})
const View = Schema.Struct({ description: Text(300), input: Json, select: Schema.Boolean })

/** What a release's `describe()` returns, checked: its name, words, state, actions and views (ADR 0021). */
export const Manifest = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(APP_NAME)),
  title: Text(60),
  description: Text(300),
  state: Schema.Struct({ schema: Json, initial: Schema.Unknown, migrate: Schema.Boolean }),
  actions: Schema.Record(Schema.String, Action),
  views: Schema.Record(Schema.String, View),
})
export type Manifest = typeof Manifest.Type

const decode = Schema.decodeUnknownOption(Manifest)

const SHAPE =
  'defineApp({ name, title, description, state: { schema, initial }, actions, views }) as the default export'

/** The problems with each action's and view's name, run function and input schema. */
function memberProblems(manifest: Manifest): string[] {
  const problems: string[] = []
  const members = [...Object.keys(manifest.actions), ...Object.keys(manifest.views)]
  if (members.length === 0) problems.push('An app needs at least one action or view.')
  if (members.length > MAX_MEMBERS) problems.push(`At most ${MAX_MEMBERS} actions and views, not ${members.length}.`)
  if (new Set(members).size !== members.length) problems.push('An action and a view share a name.')
  for (const name of members)
    if (!MEMBER_NAME.test(name)) problems.push(`"${name}": names are camelCase, like addItem.`)
  for (const [name, action] of Object.entries(manifest.actions)) {
    if (!action.run) problems.push(`Action ${name} needs run(input, ctx, prepared) returning the next state.`)
    problems.push(...inputProblems(action.input, `actions.${name}.input`))
  }
  for (const [name, view] of Object.entries(manifest.views)) {
    if (!view.select) problems.push(`View ${name} needs select(input, ctx).`)
    problems.push(...inputProblems(view.input, `views.${name}.input`))
  }
  return problems
}

function inputProblems(schema: Readonly<Record<string, unknown>>, where: string): readonly string[] {
  if (schema.type !== 'object') return [`${where}: an input is s.object({...})`]
  if (jsonBytes(schema) > MAX_SCHEMA_BYTES) return [`${where}: larger than 16 KB`]
  return schemaProblems(schema, where)
}

/**
 * The manifest a release described, or every reason it is not one an app can run as `app`: the shape, names,
 * schemas, and whether `initial` fits the state schema.
 */
export function readManifest(
  described: unknown,
  app: string,
): { readonly manifest: Manifest } | { readonly problems: readonly string[] } {
  const manifest = Option.getOrUndefined(decode(described))
  if (manifest === undefined) return { problems: [`The default export is not ${SHAPE}.`] }
  const problems = memberProblems(manifest)
  if (manifest.name !== app) problems.push(`The app is named "${app}"; its code says "${manifest.name}".`)
  const state = manifest.state.schema
  if (jsonBytes(state) > MAX_SCHEMA_BYTES) problems.push('state.schema is larger than 16 KB')
  else {
    const stateProblems = schemaProblems(state, 'state.schema')
    problems.push(...stateProblems)
    if (stateProblems.length === 0)
      problems.push(...mismatches(state, manifest.state.initial).map((reason) => `state.initial: ${reason}`))
  }
  return problems.length > 0 ? { problems } : { manifest }
}
