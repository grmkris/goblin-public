import { Conflict, InvalidInput, NotFound } from '../http/errors.ts'
import { type Isolates, type Outcome, isolateFailure } from './isolates.ts'
import { mismatches, plainJson } from './json.ts'
import { type Manifest, storedManifest } from './manifest.ts'
import type { AppPowers } from './powers.ts'
import { AppCodeError, type AppQueues } from './queue.ts'
import type { AgentAppStore } from './store.ts'

/** Sizes a call may move: its input, what `prepare` hands `run` or a view returns, and the state. */
const BYTES = { input: 64 * 1024, value: 256 * 1024, state: 1024 * 1024 } as const
/** Wall time for each kind of isolate call; the isolate's CPU limit is the other bound. */
const MS = { prepare: 30_000, run: 5000, select: 5000 } as const

export type CallRequest = {
  /** The conversation that invoked this app; browser views and scheduled jobs have none. */
  readonly session?: string | undefined
  readonly app: string
  readonly member: string
  readonly input: unknown
  /** The stable operation id: a replay with it returns the first answer. */
  readonly op: string
  /** The release the call was made against; a call must not run on code that changed under it. */
  readonly release?: string | undefined
  /** How many apps' `prepare` this call is inside of (an app calling another), 0 for the agent, a view or a job. */
  readonly depth?: number
}
export type CallResult =
  | { readonly kind: 'action'; readonly revision: number; readonly state?: unknown }
  | { readonly kind: 'view'; readonly revision: number; readonly value: unknown }

type DispatchDeps = {
  readonly store: AgentAppStore
  readonly isolates: Isolates
  readonly queues: AppQueues
  /** What one `prepare` of `app` may reach, for the call `op` at `depth`. */
  readonly powers: (request: CallRequest) => AppPowers
  readonly authorize: (request: CallRequest) => Promise<void>
  readonly now: () => number
  /** The app's state moved to a new revision. */
  readonly changed: (app: string) => void
}

/** A 32-bit seed from the operation id: `run` sees the same ids and random numbers when it runs again. */
function seedOf(op: string): number {
  let hash = 2166136261
  for (let index = 0; index < op.length; index += 1) hash = Math.imul(hash ^ op.charCodeAt(index), 16777619)
  return hash >>> 0
}

/**
 * Calls an app's actions and views, one path for every caller (ADR 0021). An action's `prepare` runs once outside the
 * app's queue, then in the queue `run` reads the current state, and the next state is checked and committed as one
 * revision with the call's receipt. A replayed operation id gets its receipt back and runs nothing.
 */
export class AppDispatch {
  readonly #deps: DispatchDeps
  readonly #manifests = new Map<string, Manifest>()

  constructor(deps: DispatchDeps) {
    this.#deps = deps
  }

  /** The release an app runs now (what a tool call pins). */
  active(app: string): string {
    const row = this.#deps.store.app(app)
    if (row === undefined) throw new NotFound({ what: `app ${app}` })
    return row.activeRelease
  }

  /** A release's manifest. */
  manifest(release: string): Manifest {
    const known = this.#manifests.get(release)
    if (known !== undefined) return known
    const row = this.#deps.store.release(release)
    if (row?.manifest == null) throw new NotFound({ what: `release ${release}` })
    const manifest = storedManifest(row.manifest)
    this.#manifests.set(release, manifest)
    return manifest
  }

  async call(request: CallRequest): Promise<CallResult> {
    await this.#deps.authorize(request)
    const { store } = this.#deps
    const release = this.active(request.app)
    if (request.release !== undefined && request.release !== release)
      throw new Conflict({ reason: `${request.app} changed while this call was in flight; call it again` })
    const manifest = this.manifest(release)
    const action = manifest.actions[request.member]
    const view = manifest.views[request.member]
    const definition = action ?? view
    if (definition === undefined) throw new NotFound({ what: `${request.app} has no action or view ${request.member}` })
    const input = plainJson(request.input ?? {}, BYTES.input, 'input')
    const problems = mismatches(definition.input, input)
    if (problems.length > 0) throw new InvalidInput({ reason: `input: ${problems.join('; ')}` })
    const api = this.#deps.isolates.release(release, () => {
      const modules = store.modules(release)
      if (modules === undefined) throw new NotFound({ what: `code of ${release}` })
      return modules
    })
    if (action === undefined) return this.#select(request, api, input, view?.output)
    const receipt = store.receipt(request.op)
    if (receipt !== undefined) return { kind: 'action', revision: receipt.revision }
    let prepared: unknown = null
    if (action.prepare) {
      const snapshot = this.#state(request.app)
      const powers = this.#deps.powers(request)
      const out = await this.#isolate(MS.prepare, `prepare of ${request.member}`, () =>
        api.prepare(request.member, input, snapshot.state, this.#deps.now(), powers),
      )
      prepared = plainJson(this.#outcome(request.app, `${request.member}.prepare`, out), BYTES.value, 'prepare')
    }
    return this.#deps.queues.run(request.app, async () => {
      await this.#deps.authorize(request)
      const current = this.#state(request.app)
      if (current.release !== release)
        throw new Conflict({ reason: `${request.app} changed while this call was in flight; call it again` })
      const out = await this.#isolate(MS.run, `run of ${request.member}`, () =>
        api.run(request.member, input, current.state, prepared, { now: this.#deps.now(), seed: seedOf(request.op) }),
      )
      const next = plainJson(this.#outcome(request.app, `${request.member}.run`, out), BYTES.state, 'the next state')
      const misfit = mismatches(manifest.state.schema, next)
      if (misfit.length > 0) {
        const message = `${request.member} returned a state that does not fit state.schema: ${misfit.join('; ')}`
        store.event(request.app, 'error', message, this.#deps.now())
        throw new AppCodeError(message)
      }
      const revision = current.revision + 1
      store.commit({
        app: request.app,
        revision: current.revision,
        state: next,
        release,
        op: request.op,
        result: { revision },
        event: `${request.member} → r${String(revision)}`,
        now: this.#deps.now(),
      })
      this.#deps.changed(request.app)
      return { kind: 'action', revision, state: next }
    })
  }

  #state(app: string) {
    const current = this.#deps.store.state(app)
    if (current === undefined) throw new NotFound({ what: `${app} state` })
    return current
  }

  /** The value of an outcome, or the app's error recorded and raised for the caller. */
  /** A view's value for `input` from the current state; one that does not fit its declared `output` is the app's error. */
  async #select(
    request: CallRequest,
    api: ReturnType<Isolates['release']>,
    input: unknown,
    output: Readonly<Record<string, unknown>> | undefined,
  ): Promise<CallResult> {
    const current = this.#state(request.app)
    const out = await this.#isolate(MS.select, `view ${request.member}`, () =>
      api.select(request.member, input, current.state, this.#deps.now()),
    )
    const value = plainJson(this.#outcome(request.app, `view ${request.member}`, out), BYTES.value, 'the view')
    const misfit = output === undefined ? [] : mismatches(output, value)
    if (misfit.length > 0) {
      const message = `view ${request.member} returned a value that does not fit its output: ${misfit.join('; ')}`
      this.#deps.store.event(request.app, 'error', message, this.#deps.now())
      throw new AppCodeError(message)
    }
    return { kind: 'view', revision: current.revision, value }
  }

  #outcome(app: string, where: string, out: Outcome): unknown {
    if (out.ok) return out.value
    const message = `${where} failed: ${out.error}`
    this.#deps.store.event(app, 'error', message, this.#deps.now())
    throw new AppCodeError(message)
  }

  async #isolate(ms: number, what: string, work: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await this.#deps.isolates.call(ms, what, work)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'IsolateTimeout') return { ok: false, error: cause.message }
      throw isolateFailure(cause)
    }
  }
}
