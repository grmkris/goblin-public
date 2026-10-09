import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

/** The owner's workspace as one live feed: every conversation and what each is doing, Apps, Home, Topics, Personas. */
export class Workspace extends Context.Service<
  Workspace,
  {
    /** The feed as Server-Sent Events: `event: snapshot`, then `event: change` batches. */
    readonly events: Effect.Effect<Response>
  }
>()('goblin/workspace/Workspace') {}
