import type { Tx } from '@earendil-works/pi-durable'
import type { MemoryStatus } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { StepResult } from './memory.ts'

/** A line of a memory's view as `zoom` names it, `id+n`: the `n` messages from message `id` on. */
export type MemoryLine = { readonly id: number; readonly n: number }

/**
 * Each Topic Conversation's memory (ADR 0032), by the Conversation's chat id: what it remembers, its builder's steps,
 * `zoom` into it, and what a Move to thread forgets. A thread has no memory of its own: `status` reports the one it
 * sits under, and its `zoom` opens that Conversation's.
 */
export class Memories extends Context.Service<
  Memories,
  {
    /** The memory of the Conversation `chat` sits under (Personal's without one); `NotFound` for an unknown chat. */
    readonly status: (chat?: string) => Effect.Effect<MemoryStatus, AppError>
    /** Messages the Conversation `chat` remembers so far. */
    readonly size: (chat: string) => Effect.Effect<number>
    /** Messages `chat` remembers up to and including its entry `entry`: what a thread branched there may zoom into. */
    readonly sizeAt: (chat: string, entry: number) => Effect.Effect<number>
    /** Turns on the memory of `chat`, a Topic's Conversation, once. */
    readonly activate: (chat: string) => Effect.Effect<void, AppError>
    /** Turns on the memory of every Topic Conversation that has none yet. */
    readonly activateConversations: () => Effect.Effect<void, AppError>
    /** Forgets `chat`'s messages from `size` on, with every summary over one (Move to thread). */
    readonly truncate: (chat: string, size: number) => Effect.Effect<void>
    /** One unit of the builder's work on `chat`: `more` until the memory has caught up. */
    readonly step: (chat: string, signal: AbortSignal) => Effect.Effect<StepResult, AppError>
    /** Starts `chat`'s builder unless one runs: `start` runs in a Pi commit on the chat, where its record lives. */
    readonly startBuilder: (chat: string, start: (tx: Tx) => Promise<void>) => Effect.Effect<void, AppError>
    /** Line `id+n` of `chat`'s memory opened, or message `id` whole when `n` is 1, within its first `limit` messages. */
    readonly zoom: (chat: string, line: MemoryLine, limit: number) => Effect.Effect<string, AppError>
  }
>()('goblin/memory/Memories') {}
