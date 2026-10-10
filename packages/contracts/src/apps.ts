import * as Schema from 'effect/Schema'
import { AgentAppJob } from './agent-apps.ts'
import { ChatId, NonEmptyString } from './ids.ts'

/** Where a kept MCP App comes from: the tool call it shows, on its server, rendering a `ui://` resource. */
export const McpAppSource = Schema.Struct({
  kind: Schema.Literal('mcp'),
  callId: Schema.String,
  serverId: Schema.String,
  tool: Schema.String,
  uri: Schema.String,
})

/** An agent app (ADR 0021): its name, the release it runs and the revision its state is at. */
export const AgentAppSource = Schema.Struct({
  kind: Schema.Literal('agent'),
  name: Schema.String,
  release: Schema.String,
  version: Schema.Number,
  revision: Schema.Number,
  jobs: Schema.Array(AgentAppJob),
})

/**
 * An App the workspace shows (ADRs 0020, 0021): an MCP App kept from a tool call in a conversation, or an agent app
 * with its home conversation. It holds no grant: an App's calls are checked live, every time.
 */
export const AppView = Schema.Struct({
  id: Schema.String,
  conversation: Schema.String,
  title: Schema.String,
  createdAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
  source: Schema.Union([McpAppSource, AgentAppSource]),
})
export type AppView = typeof AppView.Type

/** Keep the App of a tool call made in `conversation` (one from before Apps were kept, or one the owner closed). */
export const CreateApp = Schema.Struct({
  conversation: ChatId,
  callId: NonEmptyString(200),
})
export type CreateApp = typeof CreateApp.Type

/** Close an App (its iframe goes everywhere) or reopen it. */
export const UpdateApp = Schema.Struct({ closed: Schema.Boolean })
export type UpdateApp = typeof UpdateApp.Type

/** What the browser needs to load an App. An MCP App: its server and resource, and the call it shows with its result. */
export const McpAppLaunch = Schema.Struct({
  kind: Schema.Literal('mcp'),
  serverId: Schema.String,
  uri: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  result: Schema.Unknown,
})

/** The frame runtime bundles an agent app's view loads besides `core`. */
export const AgentAppLib = Schema.Literals(['charts', 'maps', 'diagrams', 'icons'])
export type AgentAppLib = typeof AgentAppLib.Type

/** An agent app: its view's built module and CSS, the libraries it uses, and its state now. */
export const AgentAppLaunch = Schema.Struct({
  kind: Schema.Literal('agent'),
  name: Schema.String,
  release: Schema.String,
  revision: Schema.Number,
  state: Schema.Unknown,
  ui: Schema.Struct({ module: Schema.String, css: Schema.String, libs: Schema.Array(AgentAppLib) }),
})
export type AgentAppLaunch = typeof AgentAppLaunch.Type

export const AppLaunch = Schema.Union([McpAppLaunch, AgentAppLaunch])
export type AppLaunch = typeof AppLaunch.Type

/** An agent app's state now: its revision, the release that runs it, and the state itself. */
export const AppSnapshot = Schema.Struct({ revision: Schema.Number, release: Schema.String, state: Schema.Unknown })
export type AppSnapshot = typeof AppSnapshot.Type

/** An action an agent app's view calls, with the frame's operation id (a replay with it runs nothing again). */
export const AppCall = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][A-Za-z0-9]{0,31}$/u)),
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  op: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/u)),
})
export type AppCall = typeof AppCall.Type

/** What a view's action call returns: the state after it, or the app's own error. */
export const AppCallResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), ...AppSnapshot.fields }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type AppCallResult = typeof AppCallResult.Type

/** A failure an agent app's view reported (an uncaught error, a render that threw). */
export const AppDiagnostic = Schema.Struct({ message: Schema.String.check(Schema.isMaxLength(4000)) })
export type AppDiagnostic = typeof AppDiagnostic.Type

/** Whether a view's failure was kept: one every ten seconds at most, so a failing render cannot flood the app's events. */
export const AppDiagnosticResult = Schema.Struct({ kept: Schema.Boolean })
export type AppDiagnosticResult = typeof AppDiagnosticResult.Type
