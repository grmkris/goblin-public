import type { CreateTopic, UpdateTopic } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { stopOwner } from '../agent-program.ts'
import type { AppError } from '../http/errors.ts'
import type { RoutineRunner } from '../routines/runner.ts'
import { Conversations, Topics, attempt, attemptSync, nowSecondsEffect } from '../services.ts'
import type { TopicActor } from './registry.ts'

/** Every Topic, archived ones included. */
export const topicList = Topics.useSync((topics) => topics.list())

/** A new Topic with its own Conversation, or the one this operation id already made. */
export const createTopic = (input: CreateTopic, actor: TopicActor) =>
  Effect.gen(function* () {
    const topics = yield* Topics
    const now = yield* nowSecondsEffect
    return (yield* attempt(() => topics.create(input, actor, now))).topic
  })

/**
 * Rename, archive, restore or change a Topic's search opt-out. Archiving (v1, ADR 0032) hides it and then stops the
 * work of its chats through the owner's own Stop: each open chat's run and queued inputs, the subagents it started and
 * a routine run in it. Every chat is stopped even when one fails, and an archive asked again stops them again, so a
 * failed request is retried by repeating it. Schedules are left as they are. Restoring starts nothing again.
 */
export const updateTopic = (
  runtime: { harness: PiHarness; routines: RoutineRunner },
  id: number,
  change: UpdateTopic,
) =>
  Effect.gen(function* () {
    const topics = yield* Topics
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    const topic = yield* attemptSync(() => topics.update(id, change, now))
    if (change.archived !== true) return topic
    const stops: Exit.Exit<boolean, AppError>[] = []
    for (const thread of conversations.openIn(id))
      stops.push(yield* Effect.exit(stopOwner({ ...runtime, thread, operationId: undefined })))
    const failed = stops.find(Exit.isFailure)
    if (failed !== undefined) return yield* Effect.failCause(failed.cause)
    return topic
  })
