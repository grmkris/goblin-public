import type { CreateTopic, TopicSeedData, TopicSetup, TopicView, UpdateTopic } from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { type AppError, attemptSync } from '../http/errors.ts'
import { KeyedLock } from '../observability/lock.ts'
import { epochSeconds } from '../clock.ts'
import { Changes } from '../runtime/changes.ts'
import type { TopicActor, TopicRegistry } from './registry.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** Topics a write made or changed, by id (ADR 0032). */
    'topics.changed': { readonly ids: readonly number[] }
  }
}

/** What `create` answers: the Topic, and whether this call made it rather than finding it by its operation id. */
type MadeTopic = { readonly topic: TopicView; readonly created: boolean }

/** A Topic just before and just after one change, read in the step that made it. */
export type TopicChange = { readonly before: TopicView; readonly after: TopicView }

/**
 * The owner's Topics (ADR 0032): each a channel with one Conversation, Personal holding Main. Creating is idempotent by
 * operation id and serialized, so a retry or a concurrent repeat finds the one Topic and its one Pi session. Archiving
 * here only marks the Topic; stopping its chats' work is the caller's (`updateTopic` in program.ts). Times are read
 * inside, in epoch seconds.
 */
export class Topics extends Context.Service<
  Topics,
  {
    /** Every Topic, archived ones included, in creation order (Personal first). */
    readonly list: Effect.Effect<readonly TopicView[]>
    /** One Topic; `NotFound` when there is none with `id`. */
    readonly get: (id: number) => Effect.Effect<TopicView, AppError>
    /**
     * A new Topic named `input.name` with a new Conversation, or the one `input.operationId` already made. A name
     * another active Topic has is a `Conflict`; a Topic made from a discussion starts with `seed`.
     */
    readonly create: (input: CreateTopic, actor: TopicActor, seed?: TopicSeedData) => Effect.Effect<MadeTopic, AppError>
    /**
     * Renames, archives or restores the Topic, or changes its search opt-out, as one new revision (none when nothing
     * changes), and answers it before and after.
     */
    readonly update: (id: number, change: UpdateTopic) => Effect.Effect<TopicChange, AppError>
    /**
     * A new setup (ADR 0040) as one new revision (none when it is the same), compare-and-set on `expectedRevision`
     * when given, answered before and after.
     */
    readonly setSetup: (
      id: number,
      setup: TopicSetup,
      expectedRevision?: number,
    ) => Effect.Effect<TopicChange, AppError>
  }
>()('goblin/topics/Topics') {
  /**
   * The Topics over `store`, the one per agent. Creates run one at a time (one Topic and one Pi session per operation
   * id, also for repeats that arrive together), and each create and real change tells `topics.changed` which Topic it
   * touched; a create found by its operation id tells it too, so a retry announces what a failed first attempt made.
   */
  static readonly make = (store: TopicRegistry) =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock
      const changes = yield* Changes
      const changed = (id: number) => changes.publish('topics.changed', { ids: [id] })
      return Topics.of({
        list: Effect.sync(() => store.list()).pipe(Effect.withSpan('Topics.list')),
        get: Effect.fn('Topics.get')(function* (id: number) {
          return yield* attemptSync(() => store.get(id))
        }),
        create: Effect.fn('Topics.create')(function* (input: CreateTopic, actor: TopicActor, seed?: TopicSeedData) {
          const now = yield* epochSeconds
          const made = yield* lock.withLock('topics.create')(store.create(input, actor, now, seed))
          yield* changed(made.topic.id)
          return made
        }),
        update: Effect.fn('Topics.update')(function* (id: number, change: UpdateTopic) {
          const now = yield* epochSeconds
          const result = yield* attemptSync(() => {
            const before = store.get(id)
            return { before, after: store.update(id, change, now) }
          })
          if (result.after.name !== result.before.name) yield* store.retitled(result.after.conversation)
          if (result.after.revision !== result.before.revision) yield* changed(id)
          return result
        }),
        setSetup: Effect.fn('Topics.setSetup')(function* (id: number, setup: TopicSetup, expectedRevision?: number) {
          const now = yield* epochSeconds
          const result = yield* attemptSync(() => {
            const before = store.get(id)
            return { before, after: store.setSetup(id, setup, expectedRevision, now) }
          })
          if (result.after.revision !== result.before.revision) yield* changed(id)
          return result
        }),
      })
    })
}
