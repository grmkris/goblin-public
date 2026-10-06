import { InvalidInput, NotFound } from '../http/errors.ts'
import { type Isolates, type ReleaseApi, type Rendered, isolateFailure } from './isolates.ts'
import { jsonBytes, mismatches, plainJson } from './json.ts'
import { type Manifest, type Power, readManifest, requestedPowers } from './manifest.ts'
import { APP_NAME, toolName } from './names.ts'
import type { AppQueues } from './queue.ts'
import type { AgentAppStore, AppViewCode } from './store.ts'

/** The generated toolchain (`@goblin/app/toolchain`), loaded only while building. */
export type Toolchain = {
  readonly TOOLCHAIN_HASH: string
  readonly SDK: string
  readonly RELEASE: string
  readonly TRANSPILER: string
  readonly STYLE: string
  readonly STYLE_SHEETS: string
  readonly RENDER: string
  readonly RENDER_IMPORTS: readonly string[]
}

/** A change to one file: `find` must occur exactly once. */
export type Edit = { readonly file: string; readonly find: string; readonly replace: string }
export type BuildRequest = {
  readonly name: string
  readonly files?: Readonly<Record<string, string>> | undefined
  readonly edits?: readonly Edit[] | undefined
  readonly note?: string | undefined
}
/** Where a build came from: the conversation (the app's home when it is new) and the tool call. */
export type BuildCaller = { readonly session: string; readonly callId: string | null }
export type Problem = { readonly file?: string; readonly line?: number; readonly message: string }
export type BuildResult =
  | {
      readonly status: 'active'
      readonly app: string
      readonly release: string
      readonly version: number
      readonly tools: readonly string[]
      readonly revision: number
      readonly migrated: boolean
      /** Whether the app has a view (`view.tsx`) the owner can open. */
      readonly ui: boolean
      /**
       * Why the render check could not render its view (it reads a browser global while rendering, or the check did not
       * run): it is active, but its view went unchecked.
       */
      readonly viewWarning?: string
      /** Powers it asks for that the owner has not approved: they fail until approved (shown to the owner here). */
      readonly approval?: { readonly app: string; readonly title: string; readonly powers: readonly Power[] }
    }
  | { readonly status: 'unchanged'; readonly app: string; readonly release: string }
  | {
      readonly status: 'failed'
      readonly app: string
      readonly release?: string
      readonly problems: readonly Problem[]
    }

/** How much code an app is, and how many apps an agent keeps (ADR 0021). */
const LIMITS = { files: 6, fileBytes: 128 * 1024, totalBytes: 384 * 1024, apps: 16 } as const
const FILE_NAME = /^[a-z][a-z0-9-]{0,31}\.(?:ts|js)$/u
/** The one file of an app's UI. */
const VIEW = 'view.tsx'
const STATE_BYTES = 1024 * 1024

/** Applies each edit to `files` in place; an edit whose `find` is not there exactly once is a problem. */
function applyEdits(files: Record<string, string>, edits: readonly Edit[]): Problem[] {
  const problems: Problem[] = []
  for (const edit of edits) {
    const text = files[edit.file]
    const at = text?.indexOf(edit.find) ?? -1
    const once = text !== undefined && at >= 0 && text.indexOf(edit.find, at + 1) < 0
    if (text === undefined) problems.push({ file: edit.file, message: 'No such file to edit.' })
    else if (once) files[edit.file] = text.slice(0, at) + edit.replace + text.slice(at + edit.find.length)
    else
      problems.push({
        file: edit.file,
        message: `"find" must occur exactly once (${at < 0 ? 'it is not there' : 'it is there more than once'}).`,
      })
  }
  return problems
}

/** What is wrong with the app's files as a whole: the entry, how many, their names and sizes. */
function fileProblems(files: Readonly<Record<string, string>>): Problem[] {
  const names = Object.keys(files)
  const problems: Problem[] = []
  if (!names.includes('app.ts') && !names.includes('app.js')) problems.push({ message: 'An app needs app.ts.' })
  if (names.length > LIMITS.files) problems.push({ message: `At most ${LIMITS.files} files.` })
  for (const name of names.filter((file) => !FILE_NAME.test(file) && file !== VIEW))
    problems.push({ file: name, message: 'File names are lowercase, like app.ts or lib.ts; the UI is view.tsx.' })
  for (const [name, text] of Object.entries(files))
    if (new TextEncoder().encode(text).byteLength > LIMITS.fileBytes)
      problems.push({ file: name, message: 'Larger than 128 KB.' })
  if (jsonBytes(files) > LIMITS.totalBytes) problems.push({ message: 'The files total more than 384 KB.' })
  return problems
}

/**
 * The sources after `files` replace (an empty text removes a file) and `edits` change the latest ones, or the
 * problems doing so.
 */
function sources(base: Readonly<Record<string, string>>, request: BuildRequest): Record<string, string> | Problem[] {
  const files: Record<string, string> = Object.fromEntries(
    Object.entries({ ...base, ...request.files }).filter(([, text]) => text !== ''),
  )
  const problems = [...applyEdits(files, request.edits ?? []), ...fileProblems(files)]
  return problems.length > 0 ? problems : files
}

/** The first 16 hex digits of the SHA-256 of `text`. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

async function releaseId(files: Readonly<Record<string, string>>, toolchain: string): Promise<string> {
  const ordered = Object.fromEntries(Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b)))
  return `r_${await sha256(JSON.stringify({ ordered, toolchain }))}`
}

/** The powers a manifest asks for that the owner has not approved yet, as the owner's card shows them. */
function approvalOf(store: AgentAppStore, manifest: Manifest) {
  const powers = requestedPowers(manifest).filter((power) => !store.approved(manifest.name, power))
  return powers.length === 0 ? {} : { approval: { app: manifest.name, title: manifest.title, powers } }
}

const toolsOf = (app: string, manifest: Manifest) => [
  ...Object.entries(manifest.actions)
    .filter(([, action]) => action.agent)
    .map(([name]) => toolName(app, name)),
  ...Object.keys(manifest.views).map((name) => toolName(app, name)),
]

/** The state a candidate's view was rendered with, as its problem names it. */
const startsWithOf = (candidate: Candidate, state: { readonly value: unknown; readonly migrated: boolean }) => {
  if (candidate.home === undefined) return 'state.initial'
  return state.migrated ? 'the migrated state' : "the app's current state"
}

/** A view that throws when rendered: the build fails with its line of view.tsx, and what runs stays as it is. */
const threwProblem = (rendered: { readonly error: string; readonly line?: number }, state: string): Problem => ({
  file: VIEW,
  ...(rendered.line !== undefined && { line: rendered.line }),
  message: `It throws when rendered with ${state}: ${rendered.error}. Read state the way initial shapes it, and guard parts that may be missing.`,
})

/** The render check's finding, or that it did not run (a timeout, a worker that failed). */
type RenderCheck = Rendered | { readonly outcome: 'not-run'; readonly error: string }

/** Why a view went unchecked, or nothing when it rendered. */
function uncheckedWarning(check: RenderCheck): string | undefined {
  if (check.outcome === 'not-run') return `the render check could not run: ${check.error}`
  if (check.outcome !== 'unchecked') return undefined
  return `it reads ${check.global} while rendering, which only the browser has, so it was not checked: read ${check.global} in useEffect or an event handler`
}

/** A build to make: its sources, the toolchain, its release id, and the app's home when the app exists. */
type Candidate = {
  readonly files: Readonly<Record<string, string>>
  readonly toolchain: Toolchain
  readonly release: string
  readonly home: string | undefined
}

type BuilderDeps = {
  readonly store: AgentAppStore
  readonly isolates: Isolates
  readonly queues: AppQueues
  readonly toolchain: () => Promise<Toolchain>
  readonly now: () => number
  /** Re-installs the app's tools once its new release is active. */
  readonly activated: (app: string) => Promise<void>
}

/**
 * Builds and activates agent app releases (ADR 0021): transpile in the toolchain isolate, `describe()` in the release's
 * own isolate, check the manifest, compile the view's styles, check that the current state fits (or migrates), then
 * make it active and re-install its tools. A failed build is kept with its problems and changes nothing that runs.
 */
export class AppBuilder {
  readonly #deps: BuilderDeps

  constructor(deps: BuilderDeps) {
    this.#deps = deps
  }

  async build(request: BuildRequest, caller: BuildCaller): Promise<BuildResult> {
    const candidate = await this.#candidate(request)
    return 'status' in candidate ? candidate : this.#make(candidate, request, caller)
  }

  /** The sources and release id of a build, or its result already when there is nothing to build. */
  async #candidate(request: BuildRequest): Promise<BuildResult | Candidate> {
    const { store } = this.#deps
    if (!APP_NAME.test(request.name)) throw new InvalidInput({ reason: 'app names are kebab-case, like reading-list' })
    const app = store.app(request.name)
    if (app === undefined && store.apps().length >= LIMITS.apps) throw new InvalidInput({ reason: 'at most 16 apps' })
    const latest = store.releases(request.name, 1)[0]
    if (latest === undefined && request.files === undefined)
      throw new InvalidInput({ reason: 'a new app needs its files' })
    const files = sources(latest === undefined ? {} : JSON.parse(latest.source), request)
    if (Array.isArray(files)) return { status: 'failed', app: request.name, problems: files }
    const toolchain = await this.#deps.toolchain()
    const release = await releaseId(files, toolchain.TOOLCHAIN_HASH)
    const prior = store.release(release)
    if (prior?.status === 'active') return { status: 'unchanged', app: request.name, release }
    if (prior?.status === 'failed')
      return { status: 'failed', app: request.name, release, problems: JSON.parse(prior.diagnostics ?? '[]') }
    return { files, toolchain, release, home: app?.homeSession }
  }

  /** Transpiles, describes and checks a candidate, then activates it in the app's queue; or keeps it as failed. */
  async #make(candidate: Candidate, request: BuildRequest, caller: BuildCaller): Promise<BuildResult> {
    const { store } = this.#deps
    const { files, toolchain, release } = candidate
    const fail = (problems: readonly Problem[]): BuildResult => {
      store.failed({
        app: request.name,
        release,
        source: files,
        toolchain: toolchain.TOOLCHAIN_HASH,
        diagnostics: problems,
        note: request.note ?? null,
        session: caller.session,
        callId: caller.callId,
        now: this.#deps.now(),
      })
      return { status: 'failed', app: request.name, release, problems }
    }
    const transpiled = await this.#transpile(toolchain, files)
    if (!transpiled.ok) return fail(transpiled.problems)
    const modules = { ...transpiled.modules, 'release.js': toolchain.RELEASE, '@goblin/app': toolchain.SDK }
    const api = this.#deps.isolates.release(release, () => modules)
    const described = await this.#attempt(3000, 'describe', () => api.describe())
    if (!described.ok) return fail([{ file: 'app.ts', message: described.error }])
    const read = readManifest(described.value, request.name)
    if ('problems' in read) return fail(read.problems.map((message) => ({ message })))
    const { manifest } = read
    const view = await this.#view(toolchain, files[VIEW], transpiled)
    if ('problems' in view) return fail(view.problems)
    return this.#deps.queues.run(request.name, async () => {
      const state = await this.#nextState(api, manifest, candidate.home === undefined)
      if ('problems' in state) return fail(state.problems)
      const startsWith = state.value === undefined ? store.state(request.name)?.state : state.value
      const rendered = view.view === undefined ? undefined : await this.#rendered(toolchain, view.view, startsWith)
      if (rendered?.outcome === 'threw') return fail([threwProblem(rendered, startsWithOf(candidate, state))])
      const warning = rendered === undefined ? undefined : uncheckedWarning(rendered)
      const version = store.activate({
        app: request.name,
        release,
        manifest,
        source: files,
        modules,
        toolchain: toolchain.TOOLCHAIN_HASH,
        note: request.note ?? null,
        session: candidate.home ?? caller.session,
        callId: caller.callId,
        state: state.value,
        view: view.view,
        now: this.#deps.now(),
      })
      if (warning !== undefined) store.event(request.name, 'error', `view: ${warning}`, this.#deps.now())
      await this.#deps.activated(request.name)
      const revision = store.state(request.name)?.revision ?? 0
      return {
        status: 'active',
        app: request.name,
        release,
        version,
        tools: toolsOf(request.name, manifest),
        revision,
        migrated: state.migrated,
        ui: view.view !== undefined,
        ...(warning !== undefined && { viewWarning: warning }),
        ...approvalOf(store, manifest),
      }
    })
  }

  /** The view's module and its stylesheet, compiled in the style isolate; none when the app has no view. */
  async #view(
    toolchain: Toolchain,
    source: string | undefined,
    transpiled: { readonly view: string; readonly libs: readonly string[] },
  ): Promise<{ readonly view: AppViewCode | undefined } | { readonly problems: readonly Problem[] }> {
    if (source === undefined || transpiled.view === '') return { view: undefined }
    const style = this.#deps.isolates.style(toolchain.TOOLCHAIN_HASH, toolchain.STYLE, toolchain.STYLE_SHEETS)
    const css = await this.#attempt(10_000, 'styles', () => style.css(source))
    if (!css.ok) return { problems: [{ file: VIEW, message: `Its styles did not compile: ${css.error}` }] }
    return { view: { module: transpiled.view, css: css.value, libs: transpiled.libs } }
  }

  /**
   * The view rendered once with the state the release starts with (ADR 0021). A check that did not run (a timeout, a
   * worker that failed) says nothing about the view's code, so it comes back as unchecked.
   */
  async #rendered(toolchain: Toolchain, view: AppViewCode, state: unknown): Promise<RenderCheck> {
    const id = await sha256(`${toolchain.RENDER}\n${view.module}`)
    const check = this.#deps.isolates.render(id, toolchain.RENDER, view.module, toolchain.RENDER_IMPORTS)
    const out = await this.#attempt(5000, 'the render check', async (): Promise<Rendered> =>
      check.render(JSON.stringify(state ?? null)),
    )
    return out.ok ? out.value : { outcome: 'not-run', error: out.error }
  }

  /** The app's state once this release is active: `initial` for a new app, the current one kept, or migrated. */
  async #nextState(
    api: ReleaseApi,
    manifest: Manifest,
    fresh: boolean,
  ): Promise<{ readonly value: unknown; readonly migrated: boolean } | { readonly problems: readonly Problem[] }> {
    if (fresh) return { value: plainJson(manifest.state.initial, STATE_BYTES, 'state.initial'), migrated: false }
    const current = this.#deps.store.state(manifest.name)
    if (current === undefined) throw new NotFound({ what: `${manifest.name} state` })
    const misfit = mismatches(manifest.state.schema, current.state)
    if (misfit.length === 0) return { value: undefined, migrated: false }
    if (!manifest.state.migrate)
      return {
        problems: [
          {
            message: `The current state does not fit the new state.schema (${misfit.join('; ')}). Add state.migrate(previous) returning a state that does.`,
          },
        ],
      }
    const attempted = await this.#attempt(3000, 'migrate', () => api.migrate(current.state))
    const migrated = attempted.ok ? attempted.value : attempted
    if (!migrated.ok) return { problems: [{ file: 'app.ts', message: `state.migrate failed: ${migrated.error}` }] }
    const value = plainJson(migrated.value, STATE_BYTES, 'migrated state')
    const still = mismatches(manifest.state.schema, value)
    if (still.length > 0)
      return {
        problems: [{ message: `state.migrate returned a state that does not fit state.schema: ${still.join('; ')}` }],
      }
    return { value, migrated: true }
  }

  async #transpile(
    toolchain: Toolchain,
    files: Readonly<Record<string, string>>,
  ): Promise<
    | {
        readonly ok: true
        readonly modules: Readonly<Record<string, string>>
        readonly view: string
        readonly libs: readonly string[]
      }
    | { readonly ok: false; readonly problems: readonly Problem[] }
  > {
    const transpiler = this.#deps.isolates.transpiler(toolchain.TOOLCHAIN_HASH, toolchain.TRANSPILER)
    try {
      const result = await this.#deps.isolates.call(10_000, 'transpiling', () => transpiler.transpile(files))
      return result.diagnostics.length === 0
        ? { ok: true, modules: result.modules, view: result.view, libs: result.libs }
        : { ok: false, problems: result.diagnostics }
    } catch (cause) {
      throw isolateFailure(cause)
    }
  }

  /** An isolate call whose failure (a module that does not load, a throw at top level, a timeout) is the app's. */
  async #attempt<T>(
    ms: number,
    what: string,
    work: () => Promise<T>,
  ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }> {
    try {
      return { ok: true, value: await this.#deps.isolates.call(ms, what, work) }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message.slice(0, 2000) : String(cause) }
    }
  }
}
