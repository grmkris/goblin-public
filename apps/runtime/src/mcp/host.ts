import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { epochSeconds } from '../clock.ts'
import { Forbidden, NotFound, attemptSync } from '../http/errors.ts'
import type { SingleFlight } from '../observability/single-flight.ts'
import { mcpAuth } from './auth.ts'
import type { McpManager } from './connections.ts'
import type { Credentials } from './credentials.ts'
import type { Grants } from './grants.ts'
import type { Labels } from './labels.ts'
import type { StepReport } from './log.ts'
import { makeManager } from './manager.ts'
import { ownerServers } from './owner-servers.ts'
import type { AddedRegistries } from './registries.ts'
import { toolAppResource } from './remote.ts'
import type { AddedServers } from './servers.ts'
import { McpConnections, McpGrants, McpServers } from './service.ts'
import type { McpManagerOptions, McpServerConfig } from './types.ts'

export type McpHostOptions = {
  /** The deployment's servers; they win over an added server with the same id. */
  readonly servers: readonly McpServerConfig[]
  readonly credentials: Credentials
  readonly grants: Grants
  readonly appUrl: string
  readonly fetch: typeof fetch
  /** The registries the owner added, searched after the built-in ones. */
  readonly registries: AddedRegistries
  /** Servers the owner added; without it, the server list is fixed. */
  readonly added?: AddedServers
  /** The owner's name for every connection; configured ones get theirs at start. */
  readonly labels: Labels
  /** Random characters for added server ids. */
  readonly random?: () => string
  /** Whether the owner uses skills from a server; without it, no server's skills are read. */
  readonly skillsEnabled?: (connectionId: string) => boolean
  /** Where each remote step is reported (the run ledger, ADR 0024). */
  readonly report?: StepReport
  /** The owner's decision on a call (held calls); without it, an ask-first tool is refused to all but the owner. */
  readonly authorizeTool?: McpManagerOptions['authorizeTool']
}

/** Grants or revokes one discovered tool; its `ui://` App resource follows the tools that use it. */
const setTool = (grants: Grants, manager: McpManager, tool: { readonly connectionId: string; readonly name: string }) =>
  Effect.fnUntraced(function* (allowed: boolean) {
    const { connectionId, name } = tool
    const snapshot = yield* manager.connect(connectionId)
    const found = snapshot.tools.find((item) => item.name === name)
    if (found === undefined) return yield* new NotFound({ what: `tool ${name}` })
    const now = yield* epochSeconds
    return yield* Effect.sync(() => {
      grants.set({ connectionId, capability: 'tool', name }, allowed, now)
      const appResource = toolAppResource(found)
      if (appResource === undefined) return grants.list()
      const stillUsed = snapshot.tools.some(
        (other) =>
          toolAppResource(other) === appResource &&
          grants.allows({ connectionId, capability: 'tool', name: other.name }),
      )
      grants.set({ connectionId, capability: 'resource', name: appResource }, stillUsed, now)
      return grants.list()
    })
  })

/**
 * Grants or revokes an App as a whole: exactly the discovered tools that declare `uri` as their App (including the
 * ones only the App may call), and the App resource itself. Nothing else on the server changes.
 */
const setApp = (grants: Grants, manager: McpManager, app: { readonly connectionId: string; readonly uri: string }) =>
  Effect.fnUntraced(function* (allowed: boolean) {
    const { connectionId, uri } = app
    const snapshot = yield* manager.connect(connectionId)
    const tools = snapshot.tools.filter((tool) => toolAppResource(tool) === uri)
    if (tools.length === 0) return yield* new NotFound({ what: `app ${uri}` })
    const now = yield* epochSeconds
    return yield* Effect.sync(() => {
      for (const tool of tools) grants.set({ connectionId, capability: 'tool', name: tool.name }, allowed, now)
      grants.set({ connectionId, capability: 'resource', name: uri }, allowed, now)
      return grants.list()
    })
  })

/** The owner's exact grants over the connections' discovered tools. */
const hostGrants = (grants: Grants, manager: McpManager): McpGrants['Service'] =>
  McpGrants.of({
    list: Effect.fn('McpGrants.list')(function* () {
      return yield* Effect.sync(() => grants.list())
    }),
    policy: Effect.fn('McpGrants.policy')(function* (connectionId: string, name: string) {
      return yield* Effect.sync(() => Option.fromNullishOr(grants.policy({ connectionId, capability: 'tool', name })))
    }),
    setTool: Effect.fn('McpGrants.setTool')(function* (connectionId: string, name: string, allowed: boolean) {
      return yield* setTool(grants, manager, { connectionId, name })(allowed)
    }),
    setAskFirst: Effect.fn('McpGrants.setAskFirst')(function* (connectionId: string, name: string, enabled: boolean) {
      return yield* attemptSync(() => {
        grants.setAskFirst({ connectionId, capability: 'tool', name }, enabled)
        return grants.list()
      })
    }),
    setApp: Effect.fn('McpGrants.setApp')(function* (connectionId: string, uri: string, allowed: boolean) {
      return yield* setApp(grants, manager, { connectionId, uri })(allowed)
    }),
  })

/** Without a held-call decision, an ask-first tool's call is refused to all but the owner. */
const askFirstRefused =
  (grants: Grants): NonNullable<McpManagerOptions['authorizeTool']> =>
  (call) =>
    call.caller !== 'human' &&
    grants.policy({ connectionId: call.connectionId, capability: 'tool', name: call.name })?.askFirst === true
      ? Effect.fail(new Forbidden({ reason: 'Owner approval required for this exact call' }))
      : Effect.void

/**
 * Outbound MCP for the resident agent: the connections (mcp/manager.ts) with their OAuth tokens (mcp/auth.ts), the
 * owner's servers (mcp/owner-servers.ts) and grants, all over the stores in `options`. Made once, by the agent's start
 * (layers/mcp.ts).
 */
export const mcpHost = (
  options: McpHostOptions,
): Layer.Layer<McpConnections | McpServers | McpGrants, never, SingleFlight> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { credentials, grants } = options
      const skillsEnabled = (connectionId: string) => options.skillsEnabled?.(connectionId) === true
      const configured: ReadonlySet<string> = new Set(options.servers.map((server) => server.connectionId))
      yield* Effect.sync(() => options.labels.ensure(options.servers))
      const added = (options.added?.list() ?? []).filter((server) => !configured.has(server.connectionId))
      const manager = yield* makeManager({
        servers: [...options.servers, ...added.map(({ connectionId, endpoint }) => ({ connectionId, endpoint }))],
        allows: (grant) => grants.allows(grant),
        authorizeTool: options.authorizeTool ?? askFirstRefused(grants),
        skillsEnabled,
        auth: yield* mcpAuth({ credentials, appUrl: options.appUrl, fetch: options.fetch }),
        fetch: options.fetch,
        ...(options.report === undefined ? {} : { report: options.report }),
      }).pipe(Effect.orDie)
      const servers = ownerServers({
        manager,
        configured,
        credentials,
        grants,
        appUrl: options.appUrl,
        fetch: options.fetch,
        registries: options.registries,
        ...(options.added === undefined ? {} : { added: options.added }),
        labels: options.labels,
        random: options.random ?? (() => crypto.randomUUID().replaceAll('-', '')),
        skillsEnabled,
      })
      return Context.mergeAll(
        McpConnections.context(manager),
        McpServers.context(servers),
        McpGrants.context(hostGrants(grants, manager)),
      )
    }),
  )
