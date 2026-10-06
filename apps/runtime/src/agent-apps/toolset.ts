import { Type } from '@earendil-works/pi-ai'
import { type Extension, type Registry, defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { AppDispatch, CallResult } from './dispatch.ts'
import { extensionName, toolName } from './names.ts'
import { problemText } from './queue.ts'
import type { AgentAppStore } from './store.ts'

/** What a tool result shows of a call: at most 8 KB of JSON. */
const RESULT_BYTES = 8 * 1024

function shown(value: unknown): string {
  const text = JSON.stringify(value)
  return text.length <= RESULT_BYTES ? text : `${text.slice(0, RESULT_BYTES)}… (cut at 8 KB; read it with a view)`
}

const result = (call: CallResult) =>
  call.kind === 'view' ? { revision: call.revision, value: call.value } : { revision: call.revision, state: call.state }

/**
 * Each app's actions and views as Pi tools (ADR 0021): one extension per app, `goblin.app.<name>`, its tools
 * `app_<name>__<member>`. Installing again replaces it, and Pi offers the change from the next model request. Every
 * call pins the release it started on (`goblin.release`), so a replay never runs on newer code, and its operation id is
 * `c<conversation>:<call>`, so a replay returns the first answer.
 */
export class AppToolset {
  readonly #store: AgentAppStore
  readonly #dispatch: AppDispatch
  readonly #extensions = new Map<string, Extension>()
  #registry: Registry | undefined

  constructor(store: AgentAppStore, dispatch: AppDispatch) {
    this.#store = store
    this.#dispatch = dispatch
  }

  attach(registry: Registry): void {
    this.#registry = registry
  }

  /** The app extensions every main and thread conversation selects. */
  extensions(): readonly Extension[] {
    return [...this.#extensions.values()]
  }

  /** Installs every app's active release (before Pi opens, so a restarted agent offers them at once). */
  restore(): void {
    for (const app of this.#store.apps()) this.install(app.name)
  }

  install(app: string): void {
    const release = this.#dispatch.active(app)
    const manifest = this.#dispatch.manifest(release)
    const members = [
      ...Object.entries(manifest.actions)
        .filter(([, action]) => action.agent)
        .map(([name, action]) => ({ name, kind: 'action', ...action })),
      ...Object.entries(manifest.views).map(([name, view]) => ({ name, kind: 'view', ...view })),
    ]
    const extension = defineExtension({
      name: extensionName(app),
      tools: members.map((member) =>
        defineTool({
          name: toolName(app, member.name),
          description: `${member.description} (${member.kind} of the app "${manifest.title}")`,
          parameters: Type.Unsafe<Record<string, unknown>>(member.input),
          replay: 'safe',
          execute: async (input, api, context) => {
            const pinned = await api.memo('goblin.release', release, context)
            try {
              const call = await this.#dispatch.call({
                app,
                member: member.name,
                input,
                op: `c${String(api.conversationId)}:${api.callId}`,
                release: pinned,
              })
              return { content: [{ type: 'text', text: shown(result(call)) }] }
            } catch (cause) {
              return { content: [{ type: 'text', text: problemText(cause) }], isError: true }
            }
          },
        }),
      ),
    })
    this.#registry?.install(extension)
    this.#extensions.set(app, extension)
  }
}
