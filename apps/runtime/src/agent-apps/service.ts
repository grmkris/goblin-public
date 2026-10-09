import type { AgentAppChange, AgentAppLaunch, AppCallResult, AppDiagnosticResult, AppSnapshot } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { AgentAppInfo } from './engine.ts'
import type { AppDetail, AppSummary } from './manage.ts'

/**
 * The agent's apps (ADR 0021) as the owner and the rest of the agent reach them: the Apps page's list and changes, and
 * a view's launch, state, action calls and reported failures. The agent's own tools (build, inspect, roll back) and the
 * apps' jobs stay on the engine the agent object made before Pi opened.
 */
export class AppEngine extends Context.Service<
  AppEngine,
  {
    /** An app's title, home, release, version, revision, whether it has a view and its schedules; undefined if none. */
    readonly info: (name: string) => Effect.Effect<AgentAppInfo | undefined, AppError>
    /** Every agent app, newest change first, without its App id (the App registry has that). */
    readonly summaries: () => Effect.Effect<readonly AppSummary[], AppError>
    /** One agent app in full: versions, powers, today's usage, files and recent events, without its App id. */
    readonly detail: (name: string) => Effect.Effect<AppDetail, AppError>
    /** One change the owner makes (roll back, pause, run now, answer a power), other than moving its home. */
    readonly change: (
      name: string,
      change: Exclude<AgentAppChange, { readonly kind: 'home' }>,
    ) => Effect.Effect<void, AppError>
    /** Moves an app's home to another conversation (the caller checks it is one of the owner's own). */
    readonly moveHome: (name: string, session: string) => Effect.Effect<void, AppError>
    /** Erases an app: its schedules, its files and every row it has. */
    readonly remove: (name: string) => Effect.Effect<void, AppError>
    /** The app's state now, with its revision and the release that runs it. */
    readonly snapshot: (name: string) => Effect.Effect<AppSnapshot, AppError>
    /** What the browser needs to load the app's view: its code, stylesheet, frame bundles and state. */
    readonly launch: (name: string) => Effect.Effect<AgentAppLaunch, AppError>
    /** An action the app's view calls as the owner: the state after it, or the app's own error. */
    readonly viewCall: (
      name: string,
      member: string,
      input: unknown,
      op: string,
    ) => Effect.Effect<AppCallResult, AppError>
    /** A failure the app's view reported, kept with its events at most once every ten seconds. */
    readonly viewError: (name: string, message: string) => Effect.Effect<AppDiagnosticResult, AppError>
  }
>()('goblin/agent-apps/AppEngine') {}
