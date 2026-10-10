import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'
import type { AppDispatch } from './dispatch.ts'
import { mismatches } from './json.ts'
import type { AgentAppStore } from './store.ts'

/** What `app_rollback` made active: the release, its version, and whether the state was kept or came from a snapshot. */
export const RolledBack = Schema.Struct({
  release: Schema.String,
  version: Schema.NullOr(Schema.Number),
  restored: Schema.Literals(['kept', 'snapshot']),
})
export type RolledBack = typeof RolledBack.Type

/** What a rollback of an app to one of its earlier releases restores, and that release's version. */
export type Restore = {
  /** The state to restore: none when the current one fits that release, else the newest snapshot that does. */
  readonly state?: unknown
  readonly version: number | null
  readonly restored: RolledBack['restored']
}

/**
 * What rolling `app` back to `release` restores: the state stays when it fits that release's schema; otherwise the
 * newest snapshot taken while that release was active comes back. `release` must be one of the app's retired ones,
 * and one of the two must fit.
 */
export function restoreOf(store: AgentAppStore, dispatch: AppDispatch, app: string, release: string): Restore {
  const row = store.release(release)
  if (row?.app !== app || row.status !== 'retired')
    throw new InvalidInput({ reason: `${release} is not an earlier version of ${app} (see app_inspect with releases)` })
  const manifest = dispatch.manifest(release)
  const current = store.state(app)
  if (current !== undefined && mismatches(manifest.state.schema, current.state).length === 0)
    return { version: row.seq, restored: 'kept' }
  const snapshot = store
    .snapshots(app)
    .find((entry) => entry.release === release && mismatches(manifest.state.schema, entry.state).length === 0)
  if (snapshot === undefined)
    throw new InvalidInput({ reason: 'the current state does not fit that version, and no snapshot from it does' })
  return { state: snapshot.state, version: row.seq, restored: 'snapshot' }
}
