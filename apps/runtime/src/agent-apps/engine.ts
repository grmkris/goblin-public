import type { Extension, Registry } from '@earendil-works/pi-durable'
import { type AgentAppLaunch, AgentAppLib, type AppCallResult, type AppSnapshot } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { FileStore } from '../files/store.ts'
import { nowMillis } from '../clock.ts'
import type { RuntimeEnv } from '../env.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { runApplicationMigrations } from '../storage/migrations.ts'
import { AppBuilder, type BuildCaller, type BuildRequest, type BuildResult, type Toolchain } from './build.ts'
import { AppDispatch } from './dispatch.ts'
import { AppFiles } from './files.ts'
import { Isolates } from './isolates.ts'
import { mismatches } from './json.ts'
import type { Manifest } from './manifest.ts'
import { toolName } from './names.ts'
import { AppCodeError, AppQueues } from './queue.ts'
import { AgentAppStore } from './store.ts'
import { AppToolset } from './toolset.ts'

export type AgentAppsDeps = {
  readonly storage: DurableObjectStorage
  readonly loader: WorkerLoader
  readonly bucket: R2Bucket
  /** The owner's user id (the agent's name), read when files are first touched. */
  readonly owner: () => string
  readonly now: () => number
  readonly toolchain: () => Promise<Toolchain & { readonly DOCS: Readonly<Record<string, string>> }>
  /** The owner's files, which `code_run` reads and writes under /agent. */
  readonly ownerFiles: FileStore
}

/** What `app_inspect` can include besides the summary. */
export type InspectPart = 'source' | 'state' | 'events' | 'releases'

const INSPECT_BYTES = 24 * 1024
/** How often a view's failure is kept, at most. */
const REPORT_MS = 10_000

/** An agent app as the App registry shows it (ADR 0021). */
export type AgentAppInfo = {
  readonly title: string
  /** The conversation the app lives in: where it was built. */
  readonly home: string
  readonly release: string
  readonly version: number
  readonly revision: number
  /** Whether its active release has a view. */
  readonly ui: boolean
}

const isAgentAppLib = Schema.is(AgentAppLib)
const clip = (text: string, bytes: number) => (text.length <= bytes ? text : `${text.slice(0, bytes)}… (cut)`)

/** An input schema's field names. */
const fields = (schema: Readonly<Record<string, unknown>>) =>
  Object.keys(typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {}).join(', ')

/** One line per member: `name(input fields)`. */
function signatures(manifest: Manifest): string {
  const actions = Object.entries(manifest.actions).map(
    ([name, action]) => `${name}(${fields(action.input)})${action.agent ? '' : ' [UI only]'}`,
  )
  const views = Object.entries(manifest.views).map(([name, view]) => `${name}(${fields(view.input)})`)
  return [
    actions.length > 0 ? `actions ${actions.join(', ')}` : '',
    views.length > 0 ? `views ${views.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ')
}

/**
 * The agent's apps (ADR 0021), built by the agent object before Pi opens: build and activate releases, dispatch calls,
 * keep each app's tools installed, roll back, and describe the apps to the model.
 */
export class AgentApps {
  readonly store: AgentAppStore
  readonly dispatch: AppDispatch
  readonly isolates: Isolates
  readonly ownerFiles: FileStore
  readonly #deps: AgentAppsDeps
  readonly #queues = new AppQueues()
  readonly #toolset: AppToolset
  readonly #builder: AppBuilder
  readonly #files = new Map<string, AppFiles>()
  readonly #listeners = new Set<(app: string) => void>()
  readonly #reported = new Map<string, number>()

  constructor(deps: AgentAppsDeps) {
    this.#deps = deps
    this.store = new AgentAppStore(drizzle(deps.storage))
    const isolates = new Isolates(deps.loader)
    this.isolates = isolates
    this.ownerFiles = deps.ownerFiles
    this.dispatch = new AppDispatch({
      store: this.store,
      isolates,
      queues: this.#queues,
      files: (app) => this.#filesOf(app),
      now: deps.now,
      changed: (app) => this.#changed(app),
    })
    this.#toolset = new AppToolset(this.store, this.dispatch)
    this.#builder = new AppBuilder({
      store: this.store,
      isolates,
      queues: this.#queues,
      toolchain: deps.toolchain,
      now: deps.now,
      activated: (app) => {
        this.#toolset.install(app)
        this.#changed(app)
      },
    })
  }

  /** Gives the toolset Pi's registry: called once, when the harness is made. */
  attach(registry: Registry): void {
    this.#toolset.attach(registry)
  }

  /** Before Pi opens: the application tables exist, and every app's tools are installed. */
  restore(): void {
    runApplicationMigrations(this.#deps.storage)
    this.#toolset.restore()
  }

  /** What the App registry shows of an app: its title and home, its release and number, revision, and view. */
  info(app: string): AgentAppInfo | undefined {
    const row = this.store.app(app)
    if (row === undefined) return undefined
    return {
      title: row.title,
      home: row.homeSession,
      release: row.activeRelease,
      version: this.store.release(row.activeRelease)?.seq ?? 0,
      revision: this.store.state(app)?.revision ?? 0,
      ui: this.store.view(row.activeRelease) !== undefined,
    }
  }

  /** The app's state now, with its revision and the release that runs it. */
  snapshot(app: string): AppSnapshot {
    const release = this.dispatch.active(app)
    const state = this.store.state(app)
    if (state === undefined) throw new NotFound({ what: `${app} state` })
    return { revision: state.revision, release, state: state.state }
  }

  /** What the browser needs to load the app's view: its code, its stylesheet, its frame bundles and its state. */
  launch(app: string): AgentAppLaunch {
    const snapshot = this.snapshot(app)
    const view = this.store.view(snapshot.release)
    if (view === undefined) throw new NotFound({ what: `a view of ${app}` })
    return {
      kind: 'agent',
      name: app,
      release: snapshot.release,
      revision: snapshot.revision,
      state: snapshot.state,
      ui: { module: view.module, css: view.css, libs: view.libs.filter(isAgentAppLib) },
    }
  }

  /**
   * An action the app's view called, as the owner: the state after it, or the app's own error (its code failed or
   * broke a rule). Views call actions only; `op` is the frame's operation id, kept apart per app.
   */
  async viewCall(app: string, member: string, input: unknown, op: string): Promise<AppCallResult> {
    if (this.dispatch.manifest(this.dispatch.active(app)).actions[member] === undefined)
      throw new InvalidInput({ reason: `${app} has no action ${member}; a view calls actions and reads the state` })
    try {
      await this.dispatch.call({ app, member, input, op: `ui:${app}:${op}` })
    } catch (cause) {
      if (cause instanceof AppCodeError) return { ok: false, error: cause.message }
      throw cause
    }
    return { ok: true, ...this.snapshot(app) }
  }

  /** A failure the app's view reported: kept with its events (at most one every ten seconds), where the agent sees it. */
  viewError(app: string, message: string): { readonly kept: boolean } {
    this.dispatch.active(app)
    const now = this.#deps.now()
    if (now - (this.#reported.get(app) ?? 0) < REPORT_MS) return { kept: false }
    this.#reported.set(app, now)
    this.store.event(app, 'error', `view: ${message.slice(0, 1000)}`, now)
    return { kept: true }
  }

  extensions(): readonly Extension[] {
    return this.#toolset.extensions()
  }

  /** Calls `listener` with an app's name whenever its state, release or tools change. */
  onChange(listener: (app: string) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  build(request: BuildRequest, caller: BuildCaller): Promise<BuildResult> {
    return this.#builder.build(request, caller)
  }

  async docs(topic: string): Promise<string> {
    const { DOCS } = await this.#deps.toolchain()
    return DOCS[topic] ?? `No topic "${topic}". Topics: ${Object.keys(DOCS).join(', ')}.`
  }

  /** The apps for the model's prompt: name, title, version, view, each member's signature, and a failure since. */
  summary(): string {
    return this.store
      .apps()
      .map((app) => {
        const manifest = this.dispatch.manifest(app.activeRelease)
        const version = this.store.release(app.activeRelease)?.seq ?? 0
        const view = this.store.view(app.activeRelease) === undefined ? '' : ', with a view'
        const [last] = this.store.events(app.name, 1)
        const failing = last?.kind === 'error' ? ` Last error: ${last.detail.slice(0, 300)}` : ''
        return `- ${app.name} (v${String(version)}, "${app.title}"${view}): ${signatures(manifest)}. Tools: ${toolName(app.name, '…')}.${failing}`
      })
      .join('\n')
  }

  inspect(app: string, include: readonly InspectPart[]): Record<string, unknown> {
    const row = this.store.app(app)
    if (row === undefined) throw new NotFound({ what: `app ${app}` })
    const manifest = this.dispatch.manifest(row.activeRelease)
    const state = this.store.state(app)
    const active = this.store.release(row.activeRelease)
    const releases = this.store.releases(app, 10)
    const latest = releases[0]
    const parts: Record<string, unknown> = {
      app: {
        name: app,
        title: row.title,
        description: row.description,
        version: active?.seq,
        release: row.activeRelease,
        revision: state?.revision,
      },
      members: signatures(manifest),
      ...(latest?.status === 'failed' && {
        lastBuildFailed: { release: latest.id, problems: JSON.parse(latest.diagnostics ?? '[]') },
      }),
    }
    if (include.includes('state')) parts.state = clip(JSON.stringify(state?.state ?? null), INSPECT_BYTES / 2)
    const source: Readonly<Record<string, string>> = JSON.parse(active?.source ?? '{}')
    if (include.includes('source')) parts.source = source
    if (include.includes('events')) parts.events = this.store.events(app, 20)
    if (include.includes('releases'))
      parts.releases = releases.map((release) => ({
        release: release.id,
        version: release.seq,
        status: release.status,
        note: release.note,
        at: release.createdAt,
      }))
    if (include.includes('source') && JSON.stringify(parts).length > INSPECT_BYTES)
      parts.source = Object.fromEntries(
        Object.entries(source).map(([file, text]) => [
          file,
          `${String(text.length)} characters: inspect with include ["source"] alone`,
        ]),
      )
    return parts
  }

  /**
   * Makes an earlier release of `app` active again. The state stays when it fits that release's schema; otherwise the
   * newest snapshot taken while that release was active comes back.
   */
  rollback(
    app: string,
    release: string,
  ): Promise<{ readonly release: string; readonly version: number | null; readonly restored: 'kept' | 'snapshot' }> {
    return this.#queues.run(app, async () => {
      const row = this.store.release(release)
      if (row?.app !== app || row.status !== 'retired')
        throw new InvalidInput({
          reason: `${release} is not an earlier version of ${app} (see app_inspect with releases)`,
        })
      const manifest = this.dispatch.manifest(release)
      const current = this.store.state(app)
      const fits = current !== undefined && mismatches(manifest.state.schema, current.state).length === 0
      const snapshot = fits
        ? undefined
        : this.store
            .snapshots(app)
            .find((entry) => entry.release === release && mismatches(manifest.state.schema, entry.state).length === 0)
      if (!fits && snapshot === undefined)
        throw new InvalidInput({ reason: 'the current state does not fit that version, and no snapshot from it does' })
      this.store.rollback({ app, release, state: snapshot?.state, now: this.#deps.now() })
      this.#toolset.install(app)
      this.#changed(app)
      return { release, version: row.seq, restored: snapshot === undefined ? 'kept' : 'snapshot' }
    })
  }

  #filesOf(app: string): AppFiles {
    const known = this.#files.get(app)
    if (known !== undefined) return known
    const files = new AppFiles(this.#deps.storage.sql, this.#deps.bucket, this.#deps.owner, app)
    this.#files.set(app, files)
    return files
  }

  #changed(app: string): void {
    for (const listener of this.#listeners) listener(app)
  }
}

/** The agent object's apps: over its SQLite, its Worker Loader and the stage's files bucket, owned by `owner`. */
export function agentApps(storage: DurableObjectStorage, env: RuntimeEnv, owner: () => string): AgentApps {
  return new AgentApps({
    storage,
    loader: env.LOADER,
    bucket: env.FILES,
    owner,
    now: nowMillis,
    toolchain: () => import('@goblin/app/toolchain'),
    ownerFiles: new FileStore(storage.sql, env.FILES, owner),
  })
}
