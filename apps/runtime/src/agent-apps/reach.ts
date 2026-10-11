import { AppCodeError } from './queue.ts'
import type { AppDispatch, CallRequest } from './dispatch.ts'
import { type Send, egress } from './egress.ts'
import type { AppFiles } from './files.ts'
import { type Power, type PowerKind, requestedPowers } from './manifest.ts'
import type { AppServices } from './ports.ts'
import { AppPowers } from './powers.ts'
import { type AgentAppStore, type UsageKind, isApproved } from './store.ts'

/** What one app may spend in a UTC day (ADR 0021): fetches, model tokens, notifications. */
const DAILY = { egress: 2000, tokens: 20_000, notify: 10 } as const
/** The longest model answer an app gets, the longest notification, and how deep apps call apps. */
const MAX_ANSWER_TOKENS = 1024
const MAX_NOTIFY = 1000
const MAX_DEPTH = 3

/** A power an app asks for, with the owner's answer. */
export type PowerView = Power & { readonly status: 'pending' | 'approved' | 'revoked' }

/** The powers `app`'s running release asks for, and the owner's answer to each. */
export function powerViews(store: AgentAppStore, dispatch: AppDispatch, app: string): readonly PowerView[] {
  const manifest = dispatch.manifest(dispatch.active(app))
  const rows = new Map(store.powers(app).map((row) => [`${row.kind} ${row.target}`, row]))
  return requestedPowers(manifest).map((power) => {
    const row = rows.get(`${power.kind} ${power.target}`)
    const status = isApproved(row) ? 'approved' : row?.revokedAt == null ? 'pending' : 'revoked'
    return { ...power, status }
  })
}

/** What an app's powers are made from: its store and dispatcher, its files, the agent's services and the internet. */
export type ReachDeps = {
  readonly store: AgentAppStore
  readonly dispatch: AppDispatch
  readonly files: (app: string) => AppFiles
  readonly services: AppServices
  readonly fetch: Send
  /** goblin's own URL: an app never fetches from its domain. */
  readonly appUrl: string
  readonly now: () => number
}

/** What one `prepare` of `app` may reach (ADR 0021): its files and log, and each power the owner approved. */
export function reachOf(deps: ReachDeps, { app, op, depth = 0, session }: CallRequest): AppPowers {
  const { store, dispatch, services, now } = deps
  const allowed = (kind: PowerKind, target: string) => {
    if (!store.approved(app, { kind, target }))
      throw new AppCodeError(
        `${kind} ${target} is not approved for ${app}. Declare it in the app (egress or uses); the owner approves it.`,
      )
  }
  const within = (kind: UsageKind, amount: number, cap: number) => {
    if (!store.spend(app, kind, amount, cap, now()))
      throw new AppCodeError(`${app} reached today's limit of ${String(cap)} ${kind === 'egress' ? 'fetches' : kind}`)
  }
  let calls = 0
  return new AppPowers({
    files: deps.files(app),
    log: (line) => store.event(app, 'log', line, now()),
    fetch: async (url, init) => {
      within('egress', 1, DAILY.egress)
      return egress(deps.fetch, url, init, {
        approved: (host) => store.approved(app, { kind: 'egress', target: host }),
        appUrl: deps.appUrl,
      })
    },
    tool: async (tool, args) => {
      allowed('tool', tool)
      const [connectionId = '', name = ''] = tool.split('/', 2)
      return services.tool({ connectionId, name, args, session })
    },
    llm: async (prompt, options) => {
      allowed('llm', '*')
      within('tokens', 0, DAILY.tokens - 1)
      const maxTokens = Math.min(Math.max(Math.trunc(options.maxTokens ?? 512), 1), MAX_ANSWER_TOKENS)
      const answer = await services.complete(options.system ?? '', prompt.slice(0, 20_000), maxTokens)
      store.spend(app, 'tokens', Math.ceil((prompt.length + answer.length) / 4), Number.MAX_SAFE_INTEGER, now())
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
      const result = await dispatch.call({
        app: target,
        member,
        input,
        op: `app:${op}:${String(calls)}`,
        depth: depth + 1,
        session,
      })
      return result.kind === 'view' ? result.value : (result.state ?? store.state(target)?.state)
    },
  })
}
