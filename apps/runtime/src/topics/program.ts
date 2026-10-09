import type { CreateTopic, TopicSeedData, TopicView, UpdateTopic } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { type StopRuntime, stopOwner } from '../agent-program.ts'
import type { AppError } from '../http/errors.ts'
import { Conversations, Receipts, Topics, attempt, attemptSync, nowSecondsEffect } from '../services.ts'
import type { TopicActor } from './registry.ts'
import type { NewReceipt } from '../organize/receipts.ts'

/** Every Topic, archived ones included. */
export const topicList = Topics.useSync((topics) => topics.list())

/** Who changed a Topic and from where: the receipt it leaves says so. `chat` is the run that did it, for the agent. */
export type Provenance = { readonly actor: TopicActor; readonly chat?: string; readonly operationId?: string }

/**
 * A new Topic with its own Conversation, or the one this operation id already made; a new one leaves a receipt. A
 * Topic made from a discussion starts with `seed` (its brief and frozen excerpts).
 */
export const createTopic = (input: CreateTopic, provenance: Provenance | TopicActor, seed?: TopicSeedData) => {
  const { actor, chat } = typeof provenance === 'string' ? { actor: provenance, chat: undefined } : provenance
  return Effect.gen(function* () {
    const topics = yield* Topics
    const receipts = yield* Receipts
    const now = yield* nowSecondsEffect
    const made = yield* attempt(() => topics.create(input, actor, now, seed))
    if (made.created)
      yield* attemptSync(() =>
        receipts.record(
          {
            kind: 'topic.create',
            target: String(made.topic.id),
            summary: `Created topic "${made.topic.name}"`,
            actor,
            ...(chat === undefined ? {} : { chat }),
            before: null,
            after: { name: made.topic.name },
            afterRevision: made.topic.revision,
            operationId: `topic.create:${input.operationId}`,
          },
          now,
        ),
      )
    return made.topic
  })
}

/**
 * Rename, archive, restore or change a Topic's search opt-out. Archiving (v1, ADR 0032) hides it and then stops the
 * work of its chats through the owner's own Stop: each open chat's run and queued inputs, the subagents it started and
 * a routine run in it. Every chat is stopped even when one fails, and an archive asked again stops them again, so a
 * failed request is retried by repeating it. Schedules are left as they are. Restoring starts nothing again.
 */
export const updateTopic = (
  runtime: StopRuntime,
  id: number,
  change: UpdateTopic,
  provenance: Provenance = { actor: 'owner' },
) =>
  Effect.gen(function* () {
    const topics = yield* Topics
    const receipts = yield* Receipts
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    const topic = yield* attemptSync(() => {
      const before = topics.get(id)
      const changed = topics.update(id, change, now)
      const organized = changed.name !== before.name || changed.archivedAt !== before.archivedAt
      if (changed.revision !== before.revision && organized)
        receipts.record(topicReceipt(before, changed, provenance), now)
      return changed
    })
    if (change.archived !== true) return topic
    const stops: Exit.Exit<boolean, AppError>[] = []
    // A run that archives its own Topic is not stopped from inside itself: it ends with its turn.
    for (const thread of conversations.openIn(id).filter((open) => open !== provenance.chat))
      stops.push(yield* Effect.exit(stopOwner({ ...runtime, thread, operationId: undefined })))
    const failed = stops.find(Exit.isFailure)
    if (failed !== undefined) return yield* Effect.failCause(failed.cause)
    return topic
  })

const snapshot = (topic: TopicView) => ({
  name: topic.name,
  archived: topic.archivedAt !== undefined,
  searchExcluded: topic.searchExcluded,
})

/** The receipt of one change to a Topic: archive and restore win over a rename made in the same change. */
function topicReceipt(before: TopicView, after: TopicView, provenance: Provenance): NewReceipt {
  const archived = after.archivedAt !== undefined
  const wasArchived = before.archivedAt !== undefined
  const kind = archived && !wasArchived ? 'topic.archive' : !archived && wasArchived ? 'topic.restore' : 'topic.rename'
  const summary =
    kind === 'topic.archive'
      ? `Archived topic "${after.name}"`
      : kind === 'topic.restore'
        ? `Restored topic "${after.name}"`
        : `Renamed topic "${before.name}" to "${after.name}"`
  return {
    kind,
    target: String(after.id),
    summary,
    actor: provenance.actor,
    ...(provenance.chat === undefined ? {} : { chat: provenance.chat }),
    before: snapshot(before),
    after: snapshot(after),
    afterRevision: after.revision,
    ...(provenance.operationId === undefined ? {} : { operationId: `${kind}:${provenance.operationId}` }),
  }
}
