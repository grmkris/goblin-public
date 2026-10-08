import * as Effect from 'effect/Effect'
import type { EntitlementPolicy } from '../billing/gates.ts'
import type { ModelBudget } from '../budget.ts'
import type { TelegramChannel } from '../channel/channel.ts'
import { nowSeconds } from '../clock.ts'
import type { McpHost } from '../mcp/host.ts'
import type { CheapModel } from '../memory/model.ts'
import type { ResidentAuthority } from '../resident.ts'
import type { CapabilityProfiles } from '../capabilities/profiles.ts'
import { Forbidden } from '../http/errors.ts'
import { AppCodeError, problemText } from './queue.ts'

/** What agent apps reach through their agent (ADR 0021): the owner's MCP tools, the cheap model and Telegram. */
export type AppServices = {
  readonly authorizeCall: (session: string | undefined, app: string) => Promise<void>
  /** One of the owner's MCP tools, called as the agent: the owner's exact grant is checked by the host, live. */
  readonly tool: (request: {
    readonly serverId: string
    readonly name: string
    readonly args: Record<string, unknown>
    readonly session?: string | undefined
  }) => Promise<unknown>
  /** One completion on the deployment's cheap model, counted toward the owner's daily budget. */
  readonly complete: (system: string, prompt: string, maxTokens: number) => Promise<string>
  /** A message to the owner on their Telegram channel; `op` makes a retry send it once. */
  readonly notify: (op: string, text: string) => Promise<void>
  /** Why the agent may not act on its own now (the owner's plan, or resident authority), or undefined if it may. */
  readonly blocked: () => Promise<string | undefined>
}

type Deps = {
  readonly capabilities: CapabilityProfiles
  readonly host: McpHost
  readonly resident: ResidentAuthority
  readonly entitlements: EntitlementPolicy
  readonly budget: ModelBudget
  readonly model: CheapModel
  readonly channel: TelegramChannel
}

/** Telegram's HTML mode reads `<`, `>` and `&`; an app's text is shown as written. */
const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The services an agent app's powers use. Each first checks what every outside act of the agent needs: the owner's
 * plan and current resident authority; a lapsed one stops the app's power, never the owner.
 */
export function appServices(deps: Deps): AppServices {
  const authority = async () => {
    await Effect.runPromise(deps.entitlements.require())
    deps.resident.require(nowSeconds())
  }
  return {
    authorizeCall: async (session, app) => {
      await authority()
      if (session !== undefined && !deps.capabilities.app(session, app))
        throw new Forbidden({ reason: 'app execution excluded here' })
    },
    tool: async ({ serverId, name, args, session }) => {
      const authorize = async () => {
        await authority()
        if (session !== undefined && !deps.capabilities.scope(session).tool(serverId, name))
          throw new Forbidden({ reason: 'app MCP tool excluded here' })
      }
      await authorize()
      return deps.host.manager.callTool(serverId, name, args, {
        caller: 'model',
        timeout: 15_000,
        authorize,
      })
    },
    complete: async (system, prompt, maxTokens) => {
      await authority()
      await deps.budget.require(nowSeconds())
      return deps.model.complete(system, prompt, maxTokens)
    },
    notify: async (op, text) => {
      await authority()
      const serverId = deps.channel.status()?.serverId
      if (serverId === undefined) throw new AppCodeError('notify: the owner has no Telegram channel connected')
      const result = await deps.host.manager.callTool(
        serverId,
        'send_message',
        { operationId: op, text: escaped(text) },
        { caller: 'model', timeout: 5000, authorize: authority },
      )
      if (result.isError === true) throw new AppCodeError('notify: the channel refused the message')
    },
    blocked: async () => {
      try {
        await authority()
        return undefined
      } catch (cause) {
        return `waiting for the owner (${problemText(cause)})`
      }
    },
  }
}
