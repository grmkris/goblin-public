import type { CapabilityTarget, HelperExclusion } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { CapabilityScope, Exclusion, PiTools } from './profiles.ts'

/**
 * What each conversation switched off (ADR 0010): the one gate every MCP, skills, subagent and app tool asks. It only
 * narrows the owner's grants, which the MCP connections still check. Times are read inside, in seconds.
 * `layers/capabilities.ts` builds it over the agent's one `CapabilityProfiles`.
 */
export class Capabilities extends Context.Service<
  Capabilities,
  {
    /** What a registered conversation may use now: its switches and, for a subagent, those of every spawner. */
    readonly scope: (session: string) => Effect.Effect<CapabilityScope>
    /** Whether an agent app's tools may run in `session`; routine scopes never get app powers. */
    readonly app: (session: string, app: string) => Effect.Effect<boolean>
    /** What `session` switched off itself. */
    readonly own: (session: string) => Effect.Effect<readonly Exclusion[]>
    /** What Reset gives `thread`: the switches of the conversation it came from. */
    readonly inherited: (thread: string) => Effect.Effect<readonly Exclusion[]>
    /** Switches one thing on or off in `session`. Pi's tool filter follows only through `syncPi`. */
    readonly set: (session: string, target: CapabilityTarget, on: boolean) => Effect.Effect<void>
    /** Switches more things off, never anything on (a Persona's fork). */
    readonly narrow: (session: string, exclusions: readonly HelperExclusion[]) => Effect.Effect<void>
    /** Gives `to` exactly the switches `from` works under. */
    readonly copy: (from: string, to: string) => Effect.Effect<void>
    /** A thread's switches back to those of the conversation it came from, applied to Pi too. */
    readonly reset: (thread: string) => Effect.Effect<void, AppError>
    /** The direct parent configures a registered helper; exclusions never widen an ancestor's ceiling. */
    readonly configureHelper: (
      parent: string,
      session: string,
      exclusions: readonly HelperExclusion[],
    ) => Effect.Effect<void, AppError>
    /** Pi's tool filter for `session`: without the subagent tools where subagents are off, else none. */
    readonly piTools: (session: string) => Effect.Effect<PiTools>
    /** Applies `session`'s tool filter to its Pi conversation, after the switches are stored. */
    readonly syncPi: (session: string) => Effect.Effect<void, AppError>
  }
>()('goblin/capabilities/Capabilities') {}
