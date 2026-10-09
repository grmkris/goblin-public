import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { jsonBytes, mismatches, schemaProblems } from './json.ts'
import { APP_NAME, MEMBER_NAME } from './names.ts'
import { StoredDataInvalid } from './stored.ts'

/** The most actions and views one app declares, and the largest schema of one. */
const MAX_MEMBERS = 12
const MAX_SCHEMA_BYTES = 16 * 1024
/** The most hosts, tools and other apps one app may ask for. */
const MAX_POWERS = { egress: 10, tools: 10, apps: 5 } as const
/** A host an app may fetch from: a DNS name (so never an IP address), lowercase. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u
/** One of the owner's MCP tools: `<server>/<tool>`. */
const TOOL = /^[\w-]{1,64}\/[\w.-]{1,128}$/u
/** The most schedules one app declares, and a daily schedule's time of day (UTC). */
const MAX_SCHEDULES = 4
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

/** How often a schedule runs its action (ADR 0021): never more often than every 15 minutes. */
export const EVERY = ['15m', '30m', '1h', '3h', '6h', '12h', '1d'] as const
export type Every = (typeof EVERY)[number]
const isEvery = (value: string): value is Every => EVERY.some((each) => each === value)

/** A checked schedule's period: `readManifest` refused any other, so another one is stored data gone wrong. */
export function everyOf(value: string): Every {
  if (!isEvery(value)) throw new StoredDataInvalid({ what: 'schedule period' })
  return value
}

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Json = Schema.Record(Schema.String, Schema.Unknown)

const Action = Schema.Struct({
  description: Text(300),
  input: Json,
  agent: Schema.Boolean,
  prepare: Schema.Boolean,
  run: Schema.Boolean,
})
/** A view: what it selects from the state for `input`, and optionally the `output` schema its value must fit. */
const View = Schema.Struct({
  description: Text(300),
  input: Json,
  output: Schema.optionalKey(Json),
  select: Schema.Boolean,
})
const Schedule = Schema.Struct({
  action: Schema.String,
  /** One of `EVERY`, checked with the other rules so a wrong one gets its own problem. */
  every: Schema.String,
  /** For a daily schedule, the time of day it runs, `HH:MM` in UTC; otherwise null. */
  at: Schema.NullOr(Schema.String),
  input: Schema.Unknown,
})
export type Schedule = typeof Schedule.Type

/** What a release's `describe()` returns, checked: its name, words, state, actions and views (ADR 0021). */
export const Manifest = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(APP_NAME)),
  title: Text(60),
  description: Text(300),
  state: Schema.Struct({ schema: Json, initial: Schema.Unknown, migrate: Schema.Boolean }),
  actions: Schema.Record(Schema.String, Action),
  views: Schema.Record(Schema.String, View),
  egress: Schema.Array(Schema.String),
  uses: Schema.Struct({
    tools: Schema.Array(Schema.String),
    apps: Schema.Array(Schema.String),
    llm: Schema.Boolean,
    notify: Schema.Boolean,
  }),
  schedules: Schema.Array(Schedule),
})
export type Manifest = typeof Manifest.Type

/** What a manifest stored before apps had powers and schedules reads as: none of either. */
const EARLIER = { egress: [], uses: { tools: [], apps: [], llm: false, notify: false }, schedules: [] } as const

/** A manifest as `activate` stored it; one kept before powers or schedules existed has none. */
export function storedManifest(json: string): Manifest {
  // SAFETY: only `activate` writes a manifest, and only one `readManifest` accepted (older ones lack later fields).
  const stored = JSON.parse(json) as Omit<Manifest, keyof typeof EARLIER> & Partial<Manifest>
  return { ...EARLIER, ...stored }
}

/** A power an app asks for (ADR 0021): a host to fetch from, an MCP tool, another app, model calls or notifications. */
export const PowerKind = Schema.Literals(['egress', 'tool', 'app', 'llm', 'notify'])
export type PowerKind = typeof PowerKind.Type
export const Power = Schema.Struct({ kind: PowerKind, target: Schema.String })
export type Power = typeof Power.Type

/** Every power a manifest asks for; `llm` and `notify` have the target `*`. */
export const requestedPowers = (manifest: Manifest): readonly Power[] => [
  ...manifest.egress.map((target) => ({ kind: 'egress' as const, target })),
  ...manifest.uses.tools.map((target) => ({ kind: 'tool' as const, target })),
  ...manifest.uses.apps.map((target) => ({ kind: 'app' as const, target })),
  ...(manifest.uses.llm ? [{ kind: 'llm' as const, target: '*' }] : []),
  ...(manifest.uses.notify ? [{ kind: 'notify' as const, target: '*' }] : []),
]

/** What is wrong with the powers a manifest asks for: their number and their names. */
function powerProblems(manifest: Manifest): string[] {
  const problems: string[] = []
  const { egress, uses } = manifest
  if (egress.length > MAX_POWERS.egress) problems.push(`At most ${MAX_POWERS.egress} hosts in egress.`)
  if (uses.tools.length > MAX_POWERS.tools) problems.push(`At most ${MAX_POWERS.tools} tools in uses.tools.`)
  if (uses.apps.length > MAX_POWERS.apps) problems.push(`At most ${MAX_POWERS.apps} apps in uses.apps.`)
  for (const host of egress.filter((each) => !HOST.test(each)))
    problems.push(`egress: "${host}" is not a host name like api.example.com (no scheme, path or IP address).`)
  for (const tool of uses.tools.filter((each) => !TOOL.test(each)))
    problems.push(`uses.tools: "${tool}" is not "<server>/<tool>".`)
  for (const app of uses.apps.filter((each) => !APP_NAME.test(each)))
    problems.push(`uses.apps: "${app}" is not an app name.`)
  if (uses.apps.includes(manifest.name)) problems.push('uses.apps: an app does not call itself.')
  return problems
}

/** What is wrong with the schedules: their number, actions, times and inputs. */
function scheduleProblems(manifest: Manifest): string[] {
  const problems: string[] = []
  const { schedules } = manifest
  if (schedules.length > MAX_SCHEDULES) problems.push(`At most ${MAX_SCHEDULES} schedules.`)
  if (new Set(schedules.map((each) => each.action)).size !== schedules.length)
    problems.push('schedules: one schedule per action.')
  for (const schedule of schedules) {
    const where = `schedules (${schedule.action})`
    const action = manifest.actions[schedule.action]
    if (action === undefined) {
      problems.push(`${where}: no action ${schedule.action} (a schedule runs an action, not a view).`)
      continue
    }
    if (!isEvery(schedule.every)) problems.push(`${where}: every is one of ${EVERY.join(', ')}.`)
    if (schedule.at !== null && schedule.every !== '1d') problems.push(`${where}: \`at\` is only for every: '1d'.`)
    if (schedule.at !== null && !TIME_OF_DAY.test(schedule.at)) problems.push(`${where}: at is "HH:MM" (UTC).`)
    problems.push(...mismatches(action.input, schedule.input).map((reason) => `${where} input: ${reason}`))
  }
  return problems
}

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
    if (view.output !== undefined) problems.push(...outputProblems(view.output, `views.${name}.output`))
  }
  return problems
}

/** A view's output may be any schema (`s.array(...)`, `s.number()`), within the size an input schema has. */
function outputProblems(schema: Readonly<Record<string, unknown>>, where: string): readonly string[] {
  if (jsonBytes(schema) > MAX_SCHEMA_BYTES) return [`${where}: larger than 16 KB`]
  return schemaProblems(schema, where)
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
  const problems = [...memberProblems(manifest), ...powerProblems(manifest), ...scheduleProblems(manifest)]
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
