import type { Extension, Registry } from '@earendil-works/pi-durable'
import { type AgentAppLaunch, AgentAppLib, type AppSnapshot } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { FileStore } from '../files/store.ts'
import { nowMillis } from '../clock.ts'
import type { RuntimeEnv } from '../env.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import {
  AppBuilder,
  type BuildCaller,
  type BuildRequest,
  type BuildResult,
  Problem,
  type Toolchain,
  readProblems,
} from './build.ts'
import { AppDispatch, type CallRequest } from './dispatch.ts'
import { AppFiles } from './files.ts'
import { Isolates } from './isolates.ts'
import { mismatches } from './json.ts'
import { type Power, type PowerKind, requestedPowers } from './manifest.ts'
import { type Send, egress } from './egress.ts'
import { eraseApp } from './erase.ts'
import { AppJobs, type JobSchedules, type JobView } from './jobs.ts'
import type { AppServices } from './ports.ts'
import { AppPowers } from './powers.ts'
import { AppCodeError, type AppLock, problemText } from './queue.ts'
import { schedulesText, signatures } from './signatures.ts'
import { AgentAppStore, type UsageKind, isApproved } from './store.ts'
import { readFiles } from './stored.ts'
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

/** What `app_rollback` made active: the release, its version, and whether the state was kept or came from a snapshot. */
export const RolledBack = Schema.Struct({
  release: Schema.String,
  version: Schema.NullOr(Schema.Number),
  restored: Schema.Literals(['kept', 'snapshot']),
})
export type RolledBack = typeof RolledBack.Type

const INSPECT_BYTES = 24 * 1024
/** How often a view's failure is kept, at most. */
const REPORT_MS = 10_000
/** What one app may spend in a UTC day (ADR 0021): fetches, model tokens, notifications. */
const DAILY = { egress: 2000, tokens: 20_000, notify: 10 } as const
/** The longest model answer an app gets, the longest notification, and how deep apps call apps. */
const MAX_ANSWER_TOKENS = 1024
const MAX_NOTIFY = 1000
const MAX_DEPTH = 3

/** A power an app asks for, with the owner's answer. */
export type PowerView = Power & { readonly status: 'pending' | 'approved' | 'revoked' }

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
const clip = (text: string, bytes: number) => (text.length <= bytes ? text : `${text.slice(0, bytes)}… (cut)`)

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
      powers: (request) => this.#powers(request),
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
    const manifest = this.dispatch.manifest(this.dispatch.active(app))
    const rows = new Map(this.store.powers(app).map((row) => [`${row.kind} ${row.target}`, row]))
    return requestedPowers(manifest).map((power) => {
      const row = rows.get(`${power.kind} ${power.target}`)
      const status = isApproved(row) ? 'approved' : row?.revokedAt == null ? 'pending' : 'revoked'
      return { ...power, status }
    })
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
    const row = this.store.app(app)
    if (row === undefined) throw new NotFound({ what: `app ${app}` })
    const manifest = this.dispatch.manifest(row.activeRelease)
    const state = this.store.state(app)
    const active = this.store.release(row.activeRelease)
    const releases = this.store.releases(app, 10)
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
      ...(include.includes('events') && { events: this.store.events(app, 20) }),
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

  /**
   * Makes an earlier release of `app` active again. The state stays when it fits that release's schema; otherwise the
   * newest snapshot taken while that release was active comes back.
   */
  rollback(app: string, release: string): Promise<RolledBack> {
    return this.#lock(app, () => this.#rollback(app, release))
  }

  async #rollback(app: string, release: string): Promise<RolledBack> {
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
    this.#deps.changed(app)
    await this.#reconcile(app)
    return { release, version: row.seq, restored: snapshot === undefined ? 'kept' : 'snapshot' }
  }

  /** What one `prepare` of `app` may reach (ADR 0021): its files and log, and each power the owner approved. */
  #powers({ app, op, depth = 0, session }: CallRequest): AppPowers {
    const now = this.#deps.now
    const allowed = (kind: PowerKind, target: string) => {
      if (!this.store.approved(app, { kind, target }))
        throw new AppCodeError(
          `${kind} ${target} is not approved for ${app}. Declare it in the app (egress or uses); the owner approves it.`,
        )
    }
    const within = (kind: UsageKind, amount: number, cap: number) => {
      if (!this.store.spend(app, kind, amount, cap, now()))
        throw new AppCodeError(`${app} reached today's limit of ${String(cap)} ${kind === 'egress' ? 'fetches' : kind}`)
    }
    const { services } = this.#deps
    let calls = 0
    return new AppPowers({
      files: this.files(app),
      log: (line) => this.store.event(app, 'log', line, now()),
      fetch: async (url, init) => {
        within('egress', 1, DAILY.egress)
        return egress(this.#deps.fetch, url, init, {
          approved: (host) => this.store.approved(app, { kind: 'egress', target: host }),
          appUrl: this.#deps.appUrl,
        })
      },
      tool: async (tool, args) => {
        allowed('tool', tool)
        const [serverId = '', name = ''] = tool.split('/', 2)
        return services.tool({ serverId, name, args, session })
      },
      llm: async (prompt, options) => {
        allowed('llm', '*')
        within('tokens', 0, DAILY.tokens - 1)
        const maxTokens = Math.min(Math.max(Math.trunc(options.maxTokens ?? 512), 1), MAX_ANSWER_TOKENS)
        const answer = await services.complete(options.system ?? '', prompt.slice(0, 20_000), maxTokens)
        this.store.spend(app, 'tokens', Math.ceil((prompt.length + answer.length) / 4), Number.MAX_SAFE_INTEGER, now())
        return answer
      },
      notify: async (text) => {
        allowed('notify', '*')
        within('notify', 1, DAILY.notify)
        calls += 1
        await services.notify(`app-${app}-${op}-${String(calls)}`.slice(0, 200), text.slice(0, MAX_NOTIFY))
      },
      app: async (target, member, input) => {
        allowed('app', target)
        if (depth + 1 > MAX_DEPTH) throw new AppCodeError(`apps call apps at most ${String(MAX_DEPTH)} deep`)
        calls += 1
        const result = await this.dispatch.call({
          app: target,
          member,
          input,
          op: `app:${op}:${String(calls)}`,
          depth: depth + 1,
          session,
        })
        return result.kind === 'view' ? result.value : (result.state ?? this.store.state(target)?.state)
      },
    })
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
