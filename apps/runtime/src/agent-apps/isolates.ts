import { Internal } from '../http/errors.ts'

/** The compatibility date every app isolate runs with: the Worker's own. */
const COMPATIBILITY_DATE = '2026-09-25'
/** Isolate calls one agent object runs at once (Cloudflare allows ten). */
const CONCURRENCY = 8

/** What an isolate call returns: a value, or the app's own error as text. */
export type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

/**
 * What the host lends an app's `prepare` (an `RpcTarget`): its own files, a log line into its events, and its approved
 * powers. Values of any shape cross as JSON text.
 */
export interface AppPowersApi {
  filesRead(path: string): Promise<string | null>
  filesWrite(path: string, text: string): Promise<void>
  filesList(dir: string): Promise<readonly { readonly path: string; readonly size: number }[]>
  filesDelete(path: string): Promise<boolean>
  log(line: string): Promise<void>
  fetch(
    url: string,
    init: { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string },
  ): Promise<{
    readonly status: number
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
  }>
  toolsCall(tool: string, args: string): Promise<string>
  llmComplete(prompt: string, options: { readonly system?: string; readonly maxTokens?: number }): Promise<string>
  notify(text: string): Promise<void>
  appsCall(app: string, member: string, input: string): Promise<string>
}

/** When `run` runs and the seed of its ids and random numbers (the same on a retry). */
export type RunClock = { readonly now: number; readonly seed: number }

/** The release entry's `App` (packages/app/src/release.ts). */
export interface ReleaseApi extends Rpc.WorkerEntrypointBranded {
  describe(): Promise<unknown>
  migrate(previous: unknown): Promise<Outcome>
  prepare(action: string, input: unknown, state: unknown, now: number, powers: AppPowersApi): Promise<Outcome>
  run(action: string, input: unknown, state: unknown, prepared: unknown, clock: RunClock): Promise<Outcome>
  select(view: string, input: unknown, state: unknown, now: number): Promise<Outcome>
}

/** The transpiler's `Transpile` (packages/app/src/transpile.ts). */
export interface TranspilerApi extends Rpc.WorkerEntrypointBranded {
  /** The server modules, and the view's module ('' without one) with its frame bundles, when `diagnostics` is empty. */
  transpile(files: Readonly<Record<string, string>>): Promise<{
    readonly modules: Readonly<Record<string, string>>
    readonly view: string
    readonly libs: readonly string[]
    readonly diagnostics: readonly { readonly file: string; readonly line?: number; readonly message: string }[]
  }>
}

/** The style compiler's `Style` (packages/app/src/style.ts). */
export interface StyleApi extends Rpc.WorkerEntrypointBranded {
  /** The CSS for a view's source. */
  css(view: string): Promise<string>
}

/** A one-off script's `Run` (agent-apps/script.ts). */
export interface ScriptApi extends Rpc.WorkerEntrypointBranded {
  /** `value` is the script's return value as JSON text. */
  run(files: unknown): Promise<{
    readonly ok: boolean
    readonly value?: string
    readonly error?: string
    readonly logs: readonly string[]
  }>
}

/** Why an isolate call gave no answer in time (it may still finish; its answer is dropped). */
export class IsolateTimeout extends Error {
  override readonly name = 'IsolateTimeout'
}

const modulesOf = (modules: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(modules).map(([name, js]) => [name, { js }]))

/**
 * The agent's Dynamic Workers (ADR 0021): every app release, the transpiler, the style compiler and one-off scripts run
 * in an isolate of their own with no network (`globalOutbound: null`), no bindings and a CPU limit. Each is cached by an
 * id that names its exact code. Calls wait for one of eight slots and give up after their wall time.
 */
export class Isolates {
  readonly #loader: WorkerLoader
  #busy = 0
  readonly #waiting: (() => void)[] = []

  constructor(loader: WorkerLoader) {
    this.#loader = loader
  }

  /** A release of an app: its modules (with `release.js` and `@goblin/app`), by the release's id. */
  release(release: string, modules: () => Readonly<Record<string, string>>): Fetcher<ReleaseApi> {
    return this.#worker(`release:${release}`, 'release.js', modules, 2000).getEntrypoint<ReleaseApi>('App')
  }

  transpiler(hash: string, source: string): Fetcher<TranspilerApi> {
    return this.#worker(
      `toolchain:${hash}`,
      'transpile.js',
      () => ({ 'transpile.js': source }),
      10_000,
    ).getEntrypoint<TranspilerApi>('Transpile')
  }

  style(hash: string, source: string, sheets: string): Fetcher<StyleApi> {
    return this.#worker(
      `style:${hash}`,
      'style.js',
      () => ({ 'style.js': source, 'sheets.js': sheets }),
      10_000,
    ).getEntrypoint<StyleApi>('Style')
  }

  script(id: string, source: string): Fetcher<ScriptApi> {
    return this.#worker(`script:${id}`, 'script.js', () => ({ 'script.js': source }), 10_000).getEntrypoint<ScriptApi>(
      'Run',
    )
  }

  /** Runs `work` once a slot is free, giving up after `ms` (the isolate's own CPU limit stops runaway code). */
  async call<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
    await this.#acquire()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new IsolateTimeout(`${what} took longer than ${String(ms / 1000)} s`)), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
      this.#release()
    }
  }

  #worker(id: string, mainModule: string, modules: () => Readonly<Record<string, string>>, cpuMs: number): WorkerStub {
    return this.#loader.get(id, () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule,
      modules: modulesOf(modules()),
      globalOutbound: null,
      limits: { cpuMs },
    }))
  }

  async #acquire(): Promise<void> {
    if (this.#busy < CONCURRENCY) {
      this.#busy += 1
      return
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve))
  }

  #release(): void {
    const next = this.#waiting.shift()
    if (next === undefined) this.#busy -= 1
    else next()
  }
}

/** An isolate's failure as an app error (an isolate that could not load, or crashed, is the app's problem too). */
export const isolateFailure = (cause: unknown): Internal =>
  new Internal({ reason: cause instanceof Error ? cause.message.slice(0, 500) : 'isolate failed' })
