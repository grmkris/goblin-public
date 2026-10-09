import type { CreateTopic, TopicSeedData, TopicView, UpdateTopic } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { ChatOperations, Conversations } from '../chats/service.ts'
import type { AppError } from '../http/errors.ts'
import type { NewReceipt } from '../organize/receipts.ts'
import { Receipts } from '../organize/service.ts'
import type { TopicActor } from './registry.ts'
import { Topics } from './service.ts'

/** Every Topic, archived ones included. */
export const topicList = Topics.use((topics) => topics.list)

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
    const made = yield* topics.create(input, actor, seed)
    if (made.created)
      yield* receipts.record({
        kind: 'topic.create',
        target: String(made.topic.id),
        summary: `Created topic "${made.topic.name}"`,
        actor,
        ...(chat === undefined ? {} : { chat }),
        before: null,
        after: { name: made.topic.name },
        afterRevision: made.topic.revision,
        operationId: `topic.create:${input.operationId}`,
      })
    return made.topic
  })
}

/**
 * Rename, archive, restore or change a Topic's search opt-out. Archiving (v1, ADR 0032) hides it and then stops the
 * work of its chats through the owner's own Stop: each open chat's run and queued inputs, the subagents it started and
 * a routine run in it. Every chat is stopped even when one fails, and an archive asked again stops them again, so a
 * failed request is retried by repeating it. Schedules are left as they are. Restoring starts nothing again.
 */
export const updateTopic = (id: number, change: UpdateTopic, provenance: Provenance = { actor: 'owner' }) =>
  Effect.gen(function* () {
    const topics = yield* Topics
    const receipts = yield* Receipts
    const { before, after } = yield* topics.update(id, change)
    const organized = after.name !== before.name || after.archivedAt !== before.archivedAt
    if (after.revision !== before.revision && organized) yield* receipts.record(topicReceipt(before, after, provenance))
    if (change.archived !== true) return after
    const operations = yield* ChatOperations
    const stops: Exit.Exit<boolean, AppError>[] = []
    // A run that archives its own Topic is not stopped from inside itself: it ends with its turn.
    for (const thread of (yield* (yield* Conversations).openIn(id)).filter((open) => open !== provenance.chat))
      stops.push(yield* Effect.exit(operations.stop(thread)))
    const failed = stops.find(Exit.isFailure)
    if (failed !== undefined) return yield* Effect.failCause(failed.cause)
    return after
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
