import type { Extension, Registry } from '@earendil-works/pi-durable'
import { type AgentAppLaunch, AgentAppLib, type AppSnapshot } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { FileStore } from '../files/store.ts'
import { nowMillis } from '../clock.ts'
import type { RuntimeEnv } from '../env.ts'
import { NotFound } from '../http/errors.ts'
import { AppBuilder, type BuildCaller, type BuildRequest, type BuildResult, type Toolchain } from './build.ts'
import { AppDispatch } from './dispatch.ts'
import { AppFiles } from './files.ts'
import { type AppInspection, type InspectPart, inspectApp } from './inspect.ts'
import { Isolates } from './isolates.ts'
import type { Power } from './manifest.ts'
import type { Send } from './egress.ts'
import { eraseApp } from './erase.ts'
import { AppJobs, type JobSchedules, type JobView } from './jobs.ts'
import type { AppServices } from './ports.ts'
import { type AppLock, problemText } from './queue.ts'
import { type PowerView, powerViews, reachOf } from './reach.ts'
import { type RolledBack, restoreOf } from './rollback.ts'
import { schedulesText, signatures } from './signatures.ts'
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
  /** How an app's `ctx.fetch` reaches the internet (tests replace it). */
  readonly fetch: Send
  /** goblin's own URL: an app never fetches from its domain. */
  readonly appUrl: string
  /** The agent object's native schedules, which run the apps' jobs. */
  readonly schedules: JobSchedules
  /** What the apps' powers reach through the agent. */
  readonly services: AppServices
  /** Holds an app's lock around the steps that change its state (the runtime's KeyedLock). */
  readonly lock: AppLock
  /** An app's state, release, tools or home changed. */
  readonly changed: (app: string) => void
}

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
  /** Its schedules. */
  readonly jobs: readonly JobView[]
}

const isAgentAppLib = Schema.is(AgentAppLib)

/**
 * The agent's apps (ADR 0021), built by the agent object before Pi opens: build and activate releases, dispatch calls,
 * keep each app's tools installed, roll back, and describe the apps to the model.
 */
export class AgentApps {
  readonly store: AgentAppStore
  readonly dispatch: AppDispatch
  readonly isolates: Isolates
  readonly ownerFiles: FileStore
  readonly jobs: AppJobs
  readonly #deps: AgentAppsDeps
  readonly #lock: AppLock
  readonly #toolset: AppToolset
  readonly #builder: AppBuilder
  readonly #files = new Map<string, AppFiles>()
  readonly #reported = new Map<string, number>()

  constructor(deps: AgentAppsDeps) {
    this.#deps = deps
    this.#lock = deps.lock
    this.store = new AgentAppStore(drizzle(deps.storage))
    const isolates = new Isolates(deps.loader)
    this.isolates = isolates
    this.ownerFiles = deps.ownerFiles
    this.dispatch = new AppDispatch({
      store: this.store,
      isolates,
      lock: this.#lock,
      powers: (request) =>
        reachOf({ store: this.store, dispatch: this.dispatch, files: (app) => this.files(app), ...deps }, request),
      authorize: async ({ session, app }) => {
        if (session !== undefined) await deps.services.authorizeCall(session, app)
      },
      now: deps.now,
      changed: deps.changed,
    })
    this.#toolset = new AppToolset(this.store, this.dispatch, (session, app) =>
      deps.services.authorizeCall(session, app),
    )
    this.jobs = new AppJobs({
      db: drizzle(deps.storage),
      store: this.store,
      manifest: (release) => this.dispatch.manifest(release),
      run: (app, member, input, op) => this.dispatch.call({ app, member, input, op }),
      blocked: () => deps.services.blocked(),
      schedules: deps.schedules,
      now: deps.now,
      changed: deps.changed,
    })
    this.#builder = new AppBuilder({
      store: this.store,
      isolates,
      lock: this.#lock,
      toolchain: deps.toolchain,
      now: deps.now,
      activated: async (app) => {
        deps.changed(app)
        await this.#reconcile(app)
      },
    })
  }

  /** Gives the toolset Pi's registry: called once, when the harness is made. */
  attach(registry: Registry): void {
    this.#toolset.attach(registry)
  }

  /** Before Pi opens (the agent made the application tables in its constructor): `app_call` is installed. */
  restore(): void {
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
      jobs: this.jobs.list(app),
    }
  }

  /** The powers the app's running release asks for, and the owner's answer to each. */
  powers(app: string): readonly PowerView[] {
    return powerViews(this.store, this.dispatch, app)
  }

  /** The owner approves or revokes one power the app asks for. */
  answer(app: string, power: Power, allowed: boolean): readonly PowerView[] {
    if (!this.powers(app).some((each) => each.kind === power.kind && each.target === power.target))
      throw new NotFound({ what: `${app} does not ask for ${power.kind} ${power.target}` })
    this.store.answer(app, power, allowed, this.#deps.now())
    this.store.event(
      app,
      'log',
      `owner ${allowed ? 'approved' : 'revoked'} ${power.kind} ${power.target}`,
      this.#deps.now(),
    )
    this.#deps.changed(app)
    return this.powers(app)
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

  build(request: BuildRequest, caller: BuildCaller): Promise<BuildResult> {
    return this.#builder.build(request, caller)
  }

  async docs(topic: string): Promise<string> {
    const { DOCS } = await this.#deps.toolchain()
    return DOCS[topic] ?? `No topic "${topic}". Topics: ${Object.keys(DOCS).join(', ')}.`
  }

  /**
   * The apps for the model's prompt: name, title, version, view, each member's signature, and a failure since; only
   * those `include` keeps (a chat's setup, ADR 0040).
   */
  summary(include: (name: string) => boolean = () => true): string {
    return this.store
      .apps()
      .filter((app) => include(app.name))
      .map((app) => {
        const manifest = this.dispatch.manifest(app.activeRelease)
        const version = this.store.release(app.activeRelease)?.seq ?? 0
        const view = this.store.view(app.activeRelease) === undefined ? '' : ', with a view'
        const [last] = this.store.events(app.name, 1)
        const failing = last?.kind === 'error' ? ` Last error: ${last.detail.slice(0, 300)}` : ''
        const waiting = this.powers(app.name).filter((power) => power.status !== 'approved')
        const asks =
          waiting.length === 0
            ? ''
            : ` Not approved by the owner yet: ${waiting.map((power) => `${power.kind} ${power.target}`).join(', ')}.`
        return `- ${app.name} (v${String(version)}, "${app.title}"${view}): ${signatures(manifest)}.${schedulesText(this.jobs.list(app.name))}${asks}${failing}`
      })
      .join('\n')
  }

  inspect(app: string, include: readonly InspectPart[]): AppInspection {
    return inspectApp(this.store, this.dispatch, app, include)
  }

  /**
   * Makes an earlier release of `app` active again. The state stays when it fits that release's schema; otherwise the
   * newest snapshot taken while that release was active comes back.
   */
  rollback(app: string, release: string): Promise<RolledBack> {
    return this.#lock(app, () => this.#rollback(app, release))
  }

  async #rollback(app: string, release: string): Promise<RolledBack> {
    const { state, version, restored } = restoreOf(this.store, this.dispatch, app, release)
    this.store.rollback({ app, release, state, now: this.#deps.now() })
    this.#deps.changed(app)
    await this.#reconcile(app)
    return { release, version, restored }
  }

  /** Arms the schedules a new or earlier release declares; a failure is kept with the app's events, not thrown. */
  async #reconcile(app: string): Promise<void> {
    await this.jobs.reconcile().catch((cause: unknown) => {
      // expected: kept as the app's own error event, which the agent and the owner's Apps page show
      this.store.event(app, 'error', `schedules: ${problemText(cause)}`, this.#deps.now())
    })
  }

  /** Moves an app's home to another conversation (the owner chose it). */
  moveHome(app: string, session: string): void {
    this.dispatch.active(app)
    this.store.setHome(app, session, this.#deps.now())
    this.#deps.changed(app)
  }

  /** Moves the home of every app that lived in one of `closed` (conversations the owner closed) to `to`. */
  rehome(closed: readonly string[], to: string): void {
    for (const app of this.store.apps()) if (closed.includes(app.homeSession)) this.moveHome(app.name, to)
  }

  /**
   * Erases an app (the owner deletes it): its schedules, its files and every row it has. A call in flight, or the
   * agent's next `app_call`, finds it gone.
   */
  async remove(app: string): Promise<void> {
    this.dispatch.active(app)
    await this.#lock(app, () => this.#remove(app))
  }

  async #remove(app: string): Promise<void> {
    await this.jobs.removeApp(app)
    await this.files(app).purge()
    eraseApp(drizzle(this.#deps.storage), app)
    this.#files.delete(app)
  }

  /**
   * `rollback` and `remove` for a program in the runtime that already holds the app's lock (`withAppLock`), so it never
   * reaches the runtime again through the engine's own lock.
   */
  readonly held = {
    rollback: (app: string, release: string): Promise<RolledBack> => this.#rollback(app, release),
    remove: (app: string): Promise<void> => this.#remove(app),
  }

  /** An app's own files. */
  files(app: string): AppFiles {
    const known = this.#files.get(app)
    if (known !== undefined) return known
    const files = new AppFiles(this.#deps.storage.sql, this.#deps.bucket, this.#deps.owner, app)
    this.#files.set(app, files)
    return files
  }
}

/**
 * What the agent object lends its apps: its native schedules, and from its bridge the powers' services, the apps'
 * lock and where a change is told (`appPorts`); tests also replace the internet and the clock.
 */
export type AppPorts = Pick<AgentAppsDeps, 'schedules' | 'services' | 'lock' | 'changed'> & {
  readonly fetch?: Send
  readonly now?: () => number
}

/** The agent object's apps: over its SQLite, its Worker Loader and the stage's files bucket, owned by `owner`. */
export function agentApps(storage: DurableObjectStorage, env: RuntimeEnv, owner: () => string, ports: AppPorts) {
  return new AgentApps({
    schedules: ports.schedules,
    services: ports.services,
    lock: ports.lock,
    changed: ports.changed,
    storage,
    loader: env.LOADER,
    bucket: env.FILES,
    owner,
    now: ports.now ?? nowMillis,
    toolchain: () => import('@goblin/app/toolchain'),
    ownerFiles: new FileStore(storage.sql, env.FILES, owner),
    fetch: ports.fetch ?? ((url, init) => fetch(url, init)),
    appUrl: env.APP_URL,
  })
}
