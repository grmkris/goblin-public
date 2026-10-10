import * as Schema from 'effect/Schema'
import { NotFound } from '../http/errors.ts'
import { Problem, readProblems } from './build.ts'
import type { AppDispatch } from './dispatch.ts'
import { signatures } from './signatures.ts'
import type { AgentAppStore } from './store.ts'
import { readFiles } from './stored.ts'

/** What `app_inspect` can include besides the summary. */
export const InspectPart = Schema.Literals(['source', 'state', 'events', 'releases'])
export type InspectPart = typeof InspectPart.Type

/** What `app_inspect` shows of an app: its version and members, and the parts asked for with `include`. */
export const AppInspection = Schema.Struct({
  app: Schema.Struct({
    name: Schema.String,
    title: Schema.String,
    description: Schema.String,
    version: Schema.optionalKey(Schema.Number),
    release: Schema.String,
    revision: Schema.optionalKey(Schema.Number),
  }),
  /** Its actions and views with their input fields, as `<apps>` lists them. */
  members: Schema.String,
  lastBuildFailed: Schema.optionalKey(Schema.Struct({ release: Schema.String, problems: Schema.Array(Problem) })),
  /** The state as JSON text, cut at half the inspection's size. */
  state: Schema.optionalKey(Schema.String),
  /** Its files, or each file's length when they are too large to show beside the rest. */
  source: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  events: Schema.optionalKey(
    Schema.Array(Schema.Struct({ kind: Schema.String, detail: Schema.String, createdAt: Schema.Number })),
  ),
  releases: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        release: Schema.String,
        version: Schema.NullOr(Schema.Number),
        status: Schema.Literals(['active', 'retired', 'failed']),
        note: Schema.NullOr(Schema.String),
        at: Schema.Number,
      }),
    ),
  ),
})
export type AppInspection = typeof AppInspection.Type

const INSPECT_BYTES = 24 * 1024
const clip = (text: string, bytes: number) => (text.length <= bytes ? text : `${text.slice(0, bytes)}… (cut)`)

/**
 * What `app_inspect` shows of `app`: its version and members, and the parts `include` asks for. Source too large to
 * show beside the rest is shown as each file's length.
 */
export function inspectApp(
  store: AgentAppStore,
  dispatch: AppDispatch,
  app: string,
  include: readonly InspectPart[],
): AppInspection {
  const row = store.app(app)
  if (row === undefined) throw new NotFound({ what: `app ${app}` })
  const manifest = dispatch.manifest(row.activeRelease)
  const state = store.state(app)
  const active = store.release(row.activeRelease)
  const releases = store.releases(app, 10)
  const latest = releases[0]
  const source = readFiles(active?.source ?? '{}')
  const inspection: AppInspection = {
    app: {
      name: app,
      title: row.title,
      description: row.description,
      ...(active?.seq == null ? {} : { version: active.seq }),
      release: row.activeRelease,
      ...(state === undefined ? {} : { revision: state.revision }),
    },
    members: signatures(manifest),
    ...(latest?.status === 'failed' && {
      lastBuildFailed: { release: latest.id, problems: readProblems(latest.diagnostics ?? '[]') },
    }),
    ...(include.includes('state') && { state: clip(JSON.stringify(state?.state ?? null), INSPECT_BYTES / 2) }),
    ...(include.includes('source') && { source }),
    ...(include.includes('events') && { events: store.events(app, 20) }),
    ...(include.includes('releases') && {
      releases: releases.map((release) => ({
        release: release.id,
        version: release.seq,
        status: release.status,
        note: release.note,
        at: release.createdAt,
      })),
    }),
  }
  if (!include.includes('source') || JSON.stringify(inspection).length <= INSPECT_BYTES) return inspection
  return {
    ...inspection,
    source: Object.fromEntries(
      Object.entries(source).map(([file, text]) => [
        file,
        `${String(text.length)} characters: inspect with include ["source"] alone`,
      ]),
    ),
  }
}
