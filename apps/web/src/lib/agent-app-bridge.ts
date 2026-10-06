// An agent app's view in its frame (ADR 0021): its action calls go to its own route with the frame's operation id, its
// state goes in as tool results carrying `goblin/state` (the newest revision wins), and its failures go back to the
// runtime, where the agent sees them.
import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { Schema } from 'effect'
import { type AppCall, AppCallResult, AppSnapshot } from '@goblin/contracts'
import { failureText, isString, record, request } from './boundary.ts'

const decodeCall = Schema.decodeUnknownSync(AppCallResult)
const decodeSnapshot = Schema.decodeUnknownSync(AppSnapshot)
const OP = /^ui:([0-9a-f-]{36})$/u

/** The routes an agent app's frame reaches, by App id. */
export type AgentAppCalls = {
  readonly call: (id: string, call: AppCall) => Promise<AppCallResult>
  readonly state: (id: string) => Promise<AppSnapshot>
  readonly report: (id: string, message: string) => Promise<void>
}

/** The owner's routes for agent app views (ADR 0021). */
export const agentAppCalls: AgentAppCalls = {
  call: async (id, body) => decodeCall(await request(`/api/apps/${id}/call`, { body })),
  state: async (id) => decodeSnapshot(await request(`/api/apps/${id}/state`)),
  report: async (id, message) => {
    await request(`/api/apps/${id}/diagnostics`, { body: { message } })
  },
}

/** A state as the view's SDK takes it: a tool result whose `_meta` carries the revision, release and state. */
export const stateResult = (snapshot: AppSnapshot): CallToolResult => ({
  content: [],
  _meta: { 'goblin/state': { revision: snapshot.revision, release: snapshot.release, state: snapshot.state } },
})

const failed = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

/** The frame's operation id for a call: the one the SDK sent, or a fresh one. */
function operation(meta: unknown): string {
  const sent = record(meta)?.['goblin/op']
  return (isString(sent) ? OP.exec(sent)?.[1] : undefined) ?? crypto.randomUUID()
}

/** Pushes an agent app's state into its frame: one fetch at a time, never an older revision than it has. */
export class StatePush {
  readonly #bridge: AppBridge
  readonly #read: () => Promise<AppSnapshot>
  #shown = -1
  #wanted = -1
  #busy = false

  constructor(bridge: AppBridge, read: () => Promise<AppSnapshot>) {
    this.#bridge = bridge
    this.#read = read
  }

  /** The frame has this state already: the launch's, or an action's answer. */
  shown(revision: number): void {
    this.#shown = Math.max(this.#shown, revision)
  }

  /** The feed says the app's state is at `revision`; the frame gets it unless it has it. */
  want(revision: number): void {
    this.#wanted = Math.max(this.#wanted, revision)
    void this.#pump()
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#shown < 0 || this.#wanted <= this.#shown) return
    this.#busy = true
    let advanced = false
    try {
      const snapshot = await this.#read()
      if (snapshot.revision > this.#shown) {
        this.#shown = snapshot.revision
        advanced = true
        await this.#bridge.sendToolResult(stateResult(snapshot))
      }
    } catch {
      // The next change in the feed tries again.
    } finally {
      this.#busy = false
    }
    if (advanced) void this.#pump()
  }
}

/** The handlers that make `bridge` an agent app's: its actions, its state and its reports. */
export function agentBridge(
  bridge: AppBridge,
  app: { readonly id: string; readonly first: AppSnapshot },
  calls: AgentAppCalls,
  report: (message: string) => void,
): StatePush {
  const { id, first } = app
  const push = new StatePush(bridge, () => calls.state(id))
  bridge.oncalltool = async (params) => {
    try {
      const body = { name: params.name, arguments: params.arguments ?? {}, op: operation(params._meta) }
      const result = await calls.call(id, body)
      if (!result.ok) return failed(result.error)
      push.shown(result.revision)
      return stateResult(result)
    } catch (cause) {
      return failed(failureText(cause))
    }
  }
  bridge.onreadresource = async () => {
    throw new Error('An agent app has no resources to read')
  }
  bridge.addEventListener('loggingmessage', ({ level, data }) => {
    if (level !== 'error' && level !== 'critical' && level !== 'alert' && level !== 'emergency') return
    // The view shows its own failure in the frame; the agent hears of it here.
    const message = (isString(data) ? data : JSON.stringify(data)).slice(0, 4000)
    void calls.report(id, message).catch(() => undefined)
  })
  bridge.addEventListener('initialized', () => {
    void bridge
      .sendToolInput({ arguments: {} })
      .then(() => bridge.sendToolResult(stateResult(first)))
      .then(() => push.shown(first.revision))
      .catch(() => report('The app could not start'))
  })
  return push
}
