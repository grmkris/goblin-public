import type { HelperExclusion } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { CapabilityScope, PiTools } from './profiles.ts'

/**
 * What each chat may use (ADR 0040): its Topic's setup, joined in a Persona's fork with the Persona's, narrowed for a
 * subagent by its spawner's exclusions and for a routine by its allowed tools. The one gate every MCP, skills, subagent
 * and app tool asks; it only chooses among the owner's grants, which the MCP connections still check.
 * `layers/capabilities.ts` builds it over functions of the agent's database (`capabilities/profiles.ts`).
 */
export class Capabilities extends Context.Service<
  Capabilities,
  {
    /** What a registered chat may use now. */
    readonly scope: (session: string) => Effect.Effect<CapabilityScope>
    /** Whether an agent app's tools may run in `session`; routine scopes never get app powers. */
    readonly app: (session: string, app: string) => Effect.Effect<boolean>
    /** The direct parent configures a registered helper; exclusions never widen an ancestor's ceiling. */
    readonly configureHelper: (
      parent: string,
      session: string,
      exclusions: readonly HelperExclusion[],
    ) => Effect.Effect<void, AppError>
    /** Pi's tool filter for `session`: without the subagent tools where subagents are off, else none. */
    readonly piTools: (session: string) => Effect.Effect<PiTools>
    /** Applies `session`'s tool filter to its Pi conversation. */
    readonly syncPi: (session: string) => Effect.Effect<void, AppError>
  }
>()('goblin/capabilities/Capabilities') {}
