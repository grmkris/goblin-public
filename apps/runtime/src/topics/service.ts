import type { CreateTopic, TopicSeedData, TopicView, UpdateTopic } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { TopicActor } from './registry.ts'

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
  }
>()('goblin/topics/Topics') {}
