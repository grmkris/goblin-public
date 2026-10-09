import type { AppLaunch, AppView } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { AppCall, AppOrigin } from './registry.ts'

/** What Home reads of an App before placing it: never an agent app's view. */
export type AppPlacement = {
  readonly source: 'mcp' | 'agent'
  readonly closed: boolean
  readonly tool: string | null
  readonly title: string
}

/** Where an open App comes from, for what it shares with the owner's message: an MCP App's server, or the agent app. */
export type AppSharing = { readonly serverId: string } | { readonly app: string }

/**
 * The owner's Apps (ADRs 0020, 0021): an MCP App kept per tool call under the conversation it was made in, and each
 * agent app with a view under its home conversation. Keeping or showing one grants nothing: an MCP App's resource and
 * calls go through the owner's grants, live, and an agent app's view calls only its own actions.
 */
export class Apps extends Context.Service<
  Apps,
  {
    /** Every App, oldest first, closed ones included. */
    readonly list: Effect.Effect<readonly AppView[], AppError>
    /** An App's source, whether it is closed, its tool and its title; `NotFound` when there is none. */
    readonly placement: (id: string) => Effect.Effect<AppPlacement, AppError>
    /** Keeps the App of call `callId` in `session`; the same call keeps the same App, reopened if it was closed. */
    readonly register: (session: string, callId: string, origin: AppOrigin) => Effect.Effect<AppView, AppError>
    /** Closes an App (it goes from every pane and transcript) or opens it again. */
    readonly update: (id: string, closed: boolean) => Effect.Effect<AppView, AppError>
    /** What the browser needs to load an App: an MCP App's call, read from its conversation, or an agent app's view. */
    readonly launch: (id: string) => Effect.Effect<AppLaunch, AppError>
    /** The `mcp_call` with id `callId` in `session` and its committed result; `NotFound` without one. */
    readonly call: (session: string, callId: string) => Effect.Effect<AppCall, AppError>
    /** The agent app an App id names; `NotFound` for an MCP App. */
    readonly agentApp: (id: string) => Effect.Effect<string, AppError>
    /** The App id of an agent app with a view, or null. */
    readonly agentId: (name: string) => Effect.Effect<string | null, AppError>
    /** The owner deleted an agent app: its App goes from every pane and list. */
    readonly removeAgent: (name: string) => Effect.Effect<void, AppError>
    /** Where open App `id` in `conversation` comes from; a closed App or one of another conversation is `NotFound`. */
    readonly originOf: (id: string, conversation: string) => Effect.Effect<AppSharing, AppError>
  }
>()('goblin/apps/Apps') {}
