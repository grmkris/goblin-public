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
import { type Manifest, type Power, type PowerKind, requestedPowers } from './manifest.ts'
import { toolName } from './names.ts'
import { type Send, egress } from './egress.ts'
import { AppJobs, type JobSchedules, type JobView } from './jobs.ts'
import type { AppServices } from './ports.ts'
import { AppPowers } from './powers.ts'
import { AppCodeError, AppQueues, problemText } from './queue.ts'
import { AgentAppStore, type UsageKind, isApproved } from './store.ts'
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
}

/** What `app_inspect` can include besides the summary. */
export type InspectPart = 'source' | 'state' | 'events' | 'releases'

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

/** An app's schedules for the model: each action, how often, and how its last run went or why it is paused. */
function schedulesText(jobs: readonly JobView[]): string {
  if (jobs.length === 0) return ''
  const each = jobs.map((job) => {
    const when = `${job.action} every ${job.every}${job.at === null ? '' : ` at ${job.at} UTC`}`
    if (job.paused !== null) return `${when} (paused by ${job.paused === 'owner' ? 'the owner' : 'failures'})`
    return job.status === null ? when : `${when} (last run ${job.status})`
  })
  return ` Schedules: ${each.join(', ')}.`
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
  readonly jobs: AppJobs
  readonly #deps: AgentAppsDeps
  readonly #queues = new AppQueues()
  readonly #toolset: AppToolset
  readonly #builder: AppBuilder
  readonly #files = new Map<string, AppFiles>()
  readonly #listeners = new Set<(app: string) => void>()
  readonly #reported = new Map<string, number>()
  #services: AppServices | undefined

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
      powers: (app, op, depth) => this.#powers(app, op, depth),
      now: deps.now,
      changed: (app) => this.#changed(app),
    })
    this.#toolset = new AppToolset(this.store, this.dispatch)
    this.jobs = new AppJobs({
      db: drizzle(deps.storage),
      store: this.store,
      manifest: (release) => this.dispatch.manifest(release),
      run: (app, member, input, op) => this.dispatch.call({ app, member, input, op }),
      blocked: () => this.#services?.blocked() ?? Promise.resolve('the agent is still starting'),
      schedules: deps.schedules,
      now: deps.now,
      changed: (app) => this.#changed(app),
    })
    this.#builder = new AppBuilder({
      store: this.store,
      isolates,
      queues: this.#queues,
      toolchain: deps.toolchain,
      now: deps.now,
      activated: async (app) => {
        this.#toolset.install(app)
        this.#changed(app)
        await this.#reconcile(app)
      },
    })
  }

  /** Gives the apps' powers what they reach through the agent: called once its services are made. */
  connect(services: AppServices): void {
    this.#services = services
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
    this.#changed(app)
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
        const waiting = this.powers(app.name).filter((power) => power.status !== 'approved')
        const asks =
          waiting.length === 0
            ? ''
            : ` Not approved by the owner yet: ${waiting.map((power) => `${power.kind} ${power.target}`).join(', ')}.`
        return `- ${app.name} (v${String(version)}, "${app.title}"${view}): ${signatures(manifest)}. Tools: ${toolName(app.name, '…')}.${schedulesText(this.jobs.list(app.name))}${asks}${failing}`
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
      await this.#reconcile(app)
      return { release, version: row.seq, restored: snapshot === undefined ? 'kept' : 'snapshot' }
    })
  }

  /** What one `prepare` of `app` may reach (ADR 0021): its files and log, and each power the owner approved. */
  #powers(app: string, op: string, depth: number): AppPowers {
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
    const services = () => {
      if (this.#services === undefined) throw new AppCodeError('the agent is still starting; try again')
      return this.#services
    }
    let calls = 0
    return new AppPowers({
      files: this.#filesOf(app),
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
        return services().tool(serverId, name, args)
      },
      llm: async (prompt, options) => {
        allowed('llm', '*')
        within('tokens', 0, DAILY.tokens - 1)
        const maxTokens = Math.min(Math.max(Math.trunc(options.maxTokens ?? 512), 1), MAX_ANSWER_TOKENS)
        const answer = await services().complete(options.system ?? '', prompt.slice(0, 20_000), maxTokens)
        this.store.spend(app, 'tokens', Math.ceil((prompt.length + answer.length) / 4), Number.MAX_SAFE_INTEGER, now())
        return answer
      },
      notify: async (text) => {
        allowed('notify', '*')
        within('notify', 1, DAILY.notify)
        calls += 1
        await services().notify(`app-${app}-${op}-${String(calls)}`.slice(0, 200), text.slice(0, MAX_NOTIFY))
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
        })
        return result.kind === 'view' ? result.value : (result.state ?? this.store.state(target)?.state)
      },
    })
  }

  /** Arms the schedules a new or earlier release declares; a failure is kept with the app's events, not thrown. */
  async #reconcile(app: string): Promise<void> {
    await this.jobs.reconcile().catch((cause: unknown) => {
      this.store.event(app, 'error', `schedules: ${problemText(cause)}`, this.#deps.now())
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

/** What the agent object lends its apps: its native schedules; tests also replace the internet and the clock. */
export type AppPorts = { readonly schedules: JobSchedules; readonly fetch?: Send; readonly now?: () => number }

/** The agent object's apps: over its SQLite, its Worker Loader and the stage's files bucket, owned by `owner`. */
export function agentApps(storage: DurableObjectStorage, env: RuntimeEnv, owner: () => string, ports: AppPorts) {
  return new AgentApps({
    schedules: ports.schedules,
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
