import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { Changes } from '../runtime/changes.ts'
import { type WorkspaceFeed, workspaceEventResponse } from './feed.ts'

/** The owner's workspace as one live feed: every conversation and what each is doing, Apps, Home, Topics, Personas. */
export class Workspace extends Context.Service<
  Workspace,
  {
    /** The feed as Server-Sent Events: `event: snapshot`, then `event: change` batches. */
    readonly events: Effect.Effect<Response>
  }
>()('goblin/workspace/Workspace') {
  /**
   * The workspace over `feed`, the agent's one feed, which follows the change bus's `topics.changed`,
   * `personas.changed`, `receipts.changed`, `home.changed`, `conversations.changed`, `apps.changed` and
   * `apps.removed`, each read as it is now.
   */
  static readonly make = (feed: WorkspaceFeed) =>
    Effect.gen(function* () {
      const changes = yield* Changes
      yield* changes.on('topics.changed', ({ ids }) => Effect.sync(() => feed.topicsChanged(ids)))
      yield* changes.on('personas.changed', ({ ids }) => Effect.sync(() => feed.personasChanged(ids)))
      yield* changes.on('receipts.changed', ({ ids }) => Effect.sync(() => feed.receiptsChanged(ids)))
      yield* changes.on('home.changed', () => Effect.sync(() => feed.homeChanged()))
      yield* changes.on('conversations.changed', ({ ids }) => Effect.sync(() => feed.conversationsChanged(ids)))
      yield* changes.on('apps.changed', ({ ids }) => Effect.sync(() => feed.appsChanged(ids)))
      yield* changes.on('apps.removed', ({ id }) => Effect.sync(() => feed.appRemoved(id)))
      return Workspace.of({
        events: Effect.sync(() => workspaceEventResponse(feed)).pipe(Effect.withSpan('Workspace.events')),
      })
    })
}
