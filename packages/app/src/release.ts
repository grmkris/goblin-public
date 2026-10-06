// The main module of an app release's Dynamic Worker (ADR 0021). It reads the app's definition and answers the host:
// `describe` returns it as data; `prepare` runs an action's effects (once), `run` its pure reducer (maybe again),
// `select` a view, `migrate` older state. Failures come back as data with the app's own stack, never as throws.
import { WorkerEntrypoint } from 'cloudflare:workers'
import app from './app.js'

type Result = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

/** What the host lends `prepare`: the app's own files, a log line into its events, and its approved powers. */
interface Powers {
  filesRead(path: string): Promise<string | null>
  filesWrite(path: string, text: string): Promise<void>
  filesList(dir: string): Promise<readonly { readonly path: string; readonly size: number }[]>
  filesDelete(path: string): Promise<boolean>
  log(line: string): Promise<void>
  fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; url: string; headers: Record<string, string>; body: string }>
  toolsCall(tool: string, args: string): Promise<string>
  llmComplete(prompt: string, options: { system?: string; maxTokens?: number }): Promise<string>
  notify(text: string): Promise<void>
  appsCall(app: string, member: string, input: string): Promise<string>
}

/** What `ctx.fetch` answers: a small Response, its body already read as text. */
const response = (answer: { status: number; url: string; headers: Record<string, string>; body: string }) =>
  Object.freeze({
    status: answer.status,
    ok: answer.status >= 200 && answer.status < 300,
    url: answer.url,
    headers: Object.freeze({ ...answer.headers }),
    text: async () => answer.body,
    json: async (): Promise<unknown> => JSON.parse(answer.body),
  })

/** `ctx` in `prepare`: the state as it is, the time, and what the host lends. */
function prepareContext(state: unknown, now: number, powers: Powers) {
  const files = Object.freeze({
    read: (path: string) => powers.filesRead(path),
    write: (path: string, text: string) => powers.filesWrite(path, text),
    list: (dir = '/') => powers.filesList(dir),
    delete: (path: string) => powers.filesDelete(path),
  })
  return Object.freeze({
    state: frozen(state),
    now,
    files,
    log: (...parts: readonly unknown[]) => void powers.log(words(...parts)),
    fetch: async (url: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
      response(await powers.fetch(String(url), init)),
    tools: Object.freeze({
      call: async (tool: string, args: unknown = {}): Promise<unknown> =>
        JSON.parse(await powers.toolsCall(tool, JSON.stringify(args))),
    }),
    llm: Object.freeze({
      complete: (prompt: string, options: { system?: string; maxTokens?: number } = {}) =>
        powers.llmComplete(prompt, options),
    }),
    notify: (text: unknown) => powers.notify(String(text)),
    apps: Object.freeze({
      call: async (target: string, action: string, input: unknown = {}): Promise<unknown> =>
        JSON.parse(await powers.appsCall(target, action, JSON.stringify(input))),
      view: async (target: string, name: string, input: unknown = {}): Promise<unknown> =>
        JSON.parse(await powers.appsCall(target, name, JSON.stringify(input))),
    }),
  })
}

type Fn = (...args: readonly unknown[]) => unknown
type Definition = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is Definition => typeof value === 'object' && value !== null
const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined)
const isFn = (value: unknown): value is Fn => typeof value === 'function'
const entries = (value: unknown): [string, unknown][] => (isObject(value) ? Object.entries(value) : [])

function failure(cause: unknown): Result {
  if (!(cause instanceof Error)) return { ok: false, error: String(cause).slice(0, 4000) }
  const head = `${cause.name}: ${cause.message}`
  const stack = cause.stack ?? ''
  return { ok: false, error: (stack.startsWith(head) ? stack : `${head}\n${stack}`).slice(0, 4000) }
}

/** A state snapshot the app cannot change by accident: `prepare` reads state, only `run` returns a new one. */
function frozen<T>(value: T): T {
  if (isObject(value)) for (const inner of Object.values(value)) frozen(inner)
  return Object.freeze(value)
}

/** mulberry32: the same seed gives the same ids and numbers, so a retried `run` reaches the same state. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false }

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string')

const words = (...parts: readonly unknown[]) =>
  parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')

export class App extends WorkerEntrypoint {
  /** The definition as data: functions become flags, schemas stay as written. */
  describe(): unknown {
    const state = field(app, 'state')
    return {
      name: field(app, 'name'),
      title: field(app, 'title'),
      description: field(app, 'description'),
      state: {
        schema: field(state, 'schema'),
        initial: field(state, 'initial'),
        migrate: isFn(field(state, 'migrate')),
      },
      actions: Object.fromEntries(
        entries(field(app, 'actions')).map(([name, action]) => [
          name,
          {
            description: field(action, 'description'),
            input: field(action, 'input') ?? EMPTY_INPUT,
            agent: field(action, 'agent') !== false,
            prepare: isFn(field(action, 'prepare')),
            run: isFn(field(action, 'run')),
          },
        ]),
      ),
      views: Object.fromEntries(
        entries(field(app, 'views')).map(([name, view]) => [
          name,
          {
            description: field(view, 'description'),
            input: field(view, 'input') ?? EMPTY_INPUT,
            ...(isObject(field(view, 'output')) && { output: field(view, 'output') }),
            select: isFn(field(view, 'select')),
          },
        ]),
      ),
      egress: strings(field(app, 'egress')),
      uses: {
        tools: strings(field(field(app, 'uses'), 'tools')),
        apps: strings(field(field(app, 'uses'), 'apps')),
        llm: field(field(app, 'uses'), 'llm') === true,
        notify: field(field(app, 'uses'), 'notify') === true,
      },
      schedules: list(field(app, 'schedules')).map((schedule) => ({
        action: field(schedule, 'action'),
        every: field(schedule, 'every'),
        at: field(schedule, 'at') ?? null,
        input: field(schedule, 'input') ?? {},
      })),
    }
  }

  migrate(previous: unknown): Result {
    const migrate = field(field(app, 'state'), 'migrate')
    if (!isFn(migrate)) return { ok: false, error: 'This app has no state.migrate.' }
    try {
      return { ok: true, value: migrate(previous) ?? null }
    } catch (cause) {
      return failure(cause)
    }
  }

  async prepare(action: string, input: unknown, state: unknown, now: number, powers: Powers): Promise<Result> {
    const prepare = field(field(field(app, 'actions'), action), 'prepare')
    if (!isFn(prepare)) return { ok: true, value: null }
    try {
      return { ok: true, value: (await prepare(input, prepareContext(state, now, powers))) ?? null }
    } catch (cause) {
      return failure(cause)
    }
  }

  run(action: string, input: unknown, state: unknown, prepared: unknown, clock: { now: number; seed: number }): Result {
    const run = field(field(field(app, 'actions'), action), 'run')
    if (!isFn(run)) return { ok: false, error: `Action ${action} has no run.` }
    const { now, seed } = clock
    const random = generator(seed)
    const id = () =>
      Array.from({ length: 4 }, () =>
        Math.floor(random() * 0x10000)
          .toString(16)
          .padStart(4, '0'),
      ).join('')
    try {
      const next = run(input, Object.freeze({ state, now, id, random }), prepared)
      return next === undefined
        ? { ok: false, error: `Action ${action} returned nothing: return the next state.` }
        : { ok: true, value: next }
    } catch (cause) {
      return failure(cause)
    }
  }

  select(view: string, input: unknown, state: unknown, now: number): Result {
    const select = field(field(field(app, 'views'), view), 'select')
    if (!isFn(select)) return { ok: false, error: `View ${view} has no select.` }
    try {
      return { ok: true, value: select(input, Object.freeze({ state: frozen(state), now })) ?? null }
    } catch (cause) {
      return failure(cause)
    }
  }
}

export default {}
