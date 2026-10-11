import type { EntryDraft, Submission } from '@earendil-works/pi-durable'
import { type NoticeData, PERSONAL_TOPIC, type UpdateConversation } from '@goblin/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from '../../clock.ts'
import { InvalidInput, attempt, attemptSync } from '../../http/errors.ts'
import type { CheapModel } from '../../memory/model.ts'
import { FlowEvents, withFlow } from '../../observability/flows.ts'
import type { SingleFlight } from '../../observability/single-flight.ts'
import { authoredContent, threadStartedContent } from '../../pi/content.ts'
import { BACKGROUND } from '../../pi/context.ts'
import { recentMessages } from '../../pi/transcript.ts'
import { appConversations } from '../../storage/schema.ts'
import { type ChatDb, chatRow, conversationAbove, isChannel } from '../directory.ts'
import type { ChatOperations, ChatWrite, NoticePost, RoutineReport } from '../service.ts'
import { closeTree, dropRelays, stopChats, subagentsBelow } from '../stops.ts'
import { type RegistryCore, changed, channelRefusal, describe, labelOf, piConversation, registered } from './core.ts'
import { routineHome } from './threads.ts'

// The registry's writes into existing chats (ADRs 0017, 0030, 0032, 0034): notes into the chat a thread or routine
// belongs to, each a passive write under that chat's lock with its receipt; names, renames, reads and Close; and the
// Stop that reaches a chat's subagents. Each tells `conversations.changed` what it changed, inside the write.

const TITLE_SYSTEM =
  'You name conversations. Reply with only a title of two to five words for the exchange you are given: no quotes, no ending punctuation.'

/** The first line of a model's title, without quotes, at most 60 characters; empty when there is none. */
const cleanTitle = (raw: string): string =>
  (raw.split('\n')[0] ?? '')
    .replaceAll(/["'`*]/gu, '')
    .trim()
    .slice(0, 60)

/** What the registry's writes work with besides its core: passive writes, flows, single flights and the namer. */
type WritePorts = {
  readonly operations: ChatOperations['Service']
  readonly flows: FlowEvents['Service']
  readonly flights: SingleFlight['Service']
  readonly namer: CheapModel
}

/**
 * Where a passive write landed: its entry id once it is in the transcript (at once when the chat is idle, else at its
 * next boundary), none when Pi did not place it. It waits outside the chat's lock.
 */
const placedOf = (submission: Submission) =>
  Effect.map(
    attempt(() => submission.wait(BACKGROUND)),
    (settled) =>
      settled.status === 'done' && settled.entry !== undefined ? Option.some(Number(settled.entry)) : Option.none(),
  )

/**
 * A Close as its `close` flow: the owner's from the app, or a subagent's own once its job is done; `count` is how many
 * chats it closed, and a Close that closed none (all were closed already) is a replay.
 */
const closing = <A, E, R>(
  flows: FlowEvents['Service'],
  close: { readonly chat: string; readonly by: 'owner' | 'done' },
  work: Effect.Effect<A, E, R>,
  count: (closed: A) => number,
) => {
  const who =
    close.by === 'owner' ? ({ via: 'app', actor: 'owner' } as const) : ({ via: 'system', actor: 'subagent' } as const)
  const flow = { flow: 'close', chat: close.chat, ...who } as const
  return work.pipe(
    withFlow(flow, (closed) => ({ count: count(closed), status: count(closed) === 0 ? 'replayed' : 'ok' })),
    Effect.provideService(FlowEvents, flows),
  )
}

/**
 * Closes `chat` and every open conversation under it in one statement, then stops each, background work included (a
 * relay waiting on a subagent, a thread's subagents): a closed conversation runs nothing. Returns what it closed.
 */
const closeChats = Effect.fn('Conversations.closeChats')(function* (
  core: RegistryCore,
  chat: string,
  by: 'owner' | 'done',
) {
  const target = yield* registered(core, chat)
  if (isChannel(target)) return yield* channelRefusal(target)
  const now = yield* epochSeconds
  const closed = yield* attemptSync(() => closeTree(core.db, chat, by, now))
  yield* changed(core, closed)
  // A job done closes from its own last relay, which has nothing left to drop.
  if (by === 'owner') yield* dropRelays(core, closed)
  yield* stopChats(core, closed)
  return closed
})

/** A thread's untitled name from its latest exchange with the cheap model. */
const nameThread = Effect.fn('Conversations.nameThread')(function* (
  core: RegistryCore,
  namer: CheapModel,
  thread: string,
) {
  const source = yield* piConversation(core, thread)
  const [question, answer] = yield* attempt(() => recentMessages(source, 2))
  if (question?.role !== 'user' || answer?.role !== 'assistant') return
  const exchange = `Owner: ${question.text.slice(0, 800)}\nAgent: ${answer.text.slice(0, 800)}`
  const title = cleanTitle(yield* attempt(() => namer.complete(TITLE_SYSTEM, exchange, 24)))
  if (title === '') return
  yield* attemptSync(() =>
    core.db
      .update(appConversations)
      .set({ title })
      .where(and(eq(appConversations.chatId, thread), isNull(appConversations.title)))
      .run(),
  )
  yield* changed(core, [thread])
})

/**
 * A note from a thread for the conversation it came from: that model sees it, labelled with the thread, and no run
 * starts. `sharedWith` is how the parent is named, for the tool's answer.
 */
const shareWrite = Effect.fn('Conversations.shareWrite')(function* (
  core: RegistryCore,
  note: { readonly thread: string; readonly text: string; readonly requestId: string },
  at: number,
) {
  const { thread, text, requestId } = note
  const row = chatRow(core.db, thread)
  if (row?.kind !== 'thread' || row.parentSession === null) return yield* new InvalidInput({ reason: 'share_back' })
  const parent = yield* registered(core, row.parentSession)
  const model = [{ role: 'user' as const, content: authoredContent(labelOf(row), text), timestamp: at }]
  const named = parent.role === 'conversation' ? `#${parent.title ?? 'topic'}` : labelOf(parent)
  const sharedWith = parent.role === 'primary' ? 'main' : named
  const write = { requestId, origin: 'agent', entry: { kind: 'app.shared', data: { thread }, model } } as const
  return { chat: parent.chatId, write, sharedWith }
})

/**
 * A thread's note into the chat it came from, as its own `share` flow. It goes in as a write submission (never a
 * direct append), so a busy parent places it at its next boundary.
 */
const shareBack = Effect.fn('Conversations.shareBack')(function* (
  core: RegistryCore,
  ports: WritePorts,
  note: { readonly thread: string; readonly text: string; readonly requestId: string },
) {
  const flow = { flow: 'share', via: 'tool', actor: 'agent', chat: note.thread, operationId: note.requestId } as const
  const shared = Effect.gen(function* () {
    const share = yield* shareWrite(core, note, yield* Clock.currentTimeMillis)
    yield* ports.operations.passiveWrite(share.chat, share.write)
    return share
  })
  const { sharedWith } = yield* shared.pipe(
    withFlow(flow, ({ chat }) => ({ parentChat: chat })),
    Effect.provideService(FlowEvents, ports.flows),
  )
  return sharedWith
})

/**
 * The note that tells its Topic's Conversation, once, about a thread the owner started with "+": owed once it has a
 * title (the cheap model's or the owner's), naming it, which that Conversation's model sees and which starts no run.
 * Nothing said in the thread goes with it, and a later rename does not rewrite it. The write's request id makes a
 * retry after a crash the same note. None when nothing is owed.
 */
const announcement = (db: ChatDb, thread: string, at: number): ChatWrite | undefined => {
  const row = chatRow(db, thread)
  if (row?.kind !== 'thread' || row.mainNote !== 'owed' || row.title === null) return undefined
  const model = [{ role: 'user' as const, content: threadStartedContent(row.title), timestamp: at }]
  const entry = { kind: 'app.thread_started', data: { thread }, model }
  return { chat: conversationAbove(db, thread), write: { requestId: `thread-started:${thread}`, entry } }
}

/** Marks a thread's announcement written: true only for the call that marked it. */
const announced = (db: ChatDb, thread: string): boolean =>
  db
    .update(appConversations)
    .set({ mainNote: 'written' })
    .where(and(eq(appConversations.chatId, thread), eq(appConversations.mainNote, 'owed')))
    .returning({ chat: appConversations.chatId })
    .all().length > 0

/** Tells a "+" thread's Conversation about it once it has a title; true only when this call wrote the note. */
const announce = Effect.fn('Conversations.announce')(function* (
  core: RegistryCore,
  operations: ChatOperations['Service'],
  thread: string,
) {
  const at = yield* Clock.currentTimeMillis
  const owed = yield* attemptSync(() => announcement(core.db, thread, at))
  if (owed === undefined) return false
  yield* operations.passiveWrite(owed.chat, owed.write)
  return yield* attemptSync(() => announced(core.db, thread))
})

/**
 * The frozen passive report of a routine's run, for its Topic's Conversation (Personal's by default, or while that
 * Topic is archived); written, it records a Pi write, not a new run or an external notification.
 */
const reportRoutine = Effect.fn('Conversations.reportRoutine')(function* (
  core: RegistryCore,
  operations: ChatOperations['Service'],
  report: RoutineReport,
) {
  const { chat } = yield* attemptSync(() => routineHome(core.db, report.topic ?? PERSONAL_TOPIC))
  const data = { thread: report.sessionId, routineId: report.routineId, runId: report.runId, outcome: report.outcome }
  yield* operations.passiveWrite(chat, {
    requestId: `routine-report:${report.runId}`,
    origin: 'routine',
    entry: { kind: 'app.routine', data, model: [{ role: 'user', content: report.text, timestamp: report.at }] },
  })
})

/** A notice's data as the entry keeps it: JSON with no key left undefined. */
const noticeJson = (notice: NoticeData) => ({
  notice: notice.notice,
  routine: notice.routine,
  source: notice.source,
  from: {
    label: notice.from.label,
    ...(notice.from.connectionId === undefined ? {} : { connectionId: notice.from.connectionId }),
  },
  title: notice.title,
  ...(notice.body === undefined ? {} : { body: notice.body }),
  ...(notice.url === undefined ? {} : { url: notice.url }),
  ...(notice.event === undefined ? {} : { event: { name: notice.event.name, occurredAt: notice.event.occurredAt } }),
  ...(notice.folded === undefined ? {} : { folded: notice.folded }),
})

/** A routine's notice into the chat it was claimed for: passive, so no run starts (ADR 0041). */
const postNotice = Effect.fn('Conversations.postNotice')(function* (
  operations: ChatOperations['Service'],
  notice: NoticePost,
) {
  yield* operations.passiveWrite(notice.chat, {
    requestId: notice.requestId,
    origin: 'routine',
    entry: {
      kind: 'app.notice',
      data: noticeJson(notice.data),
      model: [{ role: 'user', content: notice.text, timestamp: notice.at }],
    },
  })
})

/**
 * Rename, close or reopen, or pin a subagent open. Main keeps its name and never closes. Closing stops and closes the
 * conversation with everything under it, as its `close` flow; reopening opens only the one asked for.
 */
const update = Effect.fn('Conversations.update')(function* (
  core: RegistryCore,
  flows: FlowEvents['Service'],
  chat: string,
  change: UpdateConversation,
) {
  const row = yield* registered(core, chat)
  if (isChannel(row)) return yield* channelRefusal(row)
  if (change.keepOpen !== undefined && row.kind !== 'subagent') return yield* new InvalidInput({ reason: 'keep_open' })
  const now = yield* epochSeconds
  const set = {
    ...(change.title === undefined ? {} : { title: change.title }),
    ...(change.keepOpen === undefined ? {} : { keepOpenAt: change.keepOpen ? now : null }),
    ...(change.closed === false ? { closedAt: null, closedBy: null } : {}),
  }
  const updating = Effect.gen(function* () {
    if (Object.keys(set).length > 0) {
      yield* attemptSync(() => core.db.update(appConversations).set(set).where(eq(appConversations.chatId, chat)).run())
      yield* changed(core, [chat])
    }
    const closed = change.closed === true ? yield* closeChats(core, chat, 'owner') : []
    return { view: yield* describe(core, yield* registered(core, chat)), closed }
  })
  if (change.closed !== true) return yield* updating
  return yield* closing(flows, { chat, by: 'owner' }, updating, (updated) => updated.closed.length)
})

/** The owner has seen `chat` up to now, so replies until then are read. The mark only moves forward. */
const markRead = Effect.fn('Conversations.markRead')(function* (core: RegistryCore, chat: string) {
  yield* registered(core, chat)
  const now = yield* epochSeconds
  const moved = yield* attemptSync(() =>
    core.db.all<{ session_id: string }>(
      sql`UPDATE app_conversations SET read_at = ${now}
          WHERE session_id = ${chat} AND (read_at IS NULL OR read_at < ${now})
          RETURNING session_id`,
    ),
  )
  if (moved.length > 0) yield* changed(core, [chat])
})

/**
 * Stops every open subagent below `chat`, through subagents of subagents: Stop in a conversation reaches the helpers
 * it started. Threads branched from it are the owner's own and keep going. Nothing still on its way to `chat` or below
 * reports: a stopped job reports nothing. Call it before stopping `chat` itself.
 */
const stopSubagents = Effect.fn('Conversations.stopSubagents')(function* (core: RegistryCore, chat: string) {
  const stopping = yield* attemptSync(() => subagentsBelow(core.db, chat))
  yield* dropRelays(core, [chat, ...stopping])
  yield* stopChats(core, stopping)
})

/** The registry's writes over its core and ports. */
export const registryWrites = (core: RegistryCore, ports: WritePorts) => ({
  touched: (chats: readonly string[]) => changed(core, chats).pipe(Effect.withSpan('Conversations.touched')),
  reportRoutine: (report: RoutineReport) => reportRoutine(core, ports.operations, report),
  routineHome: (topic: number) => attemptSync(() => routineHome(core.db, topic)),
  postNotice: (notice: NoticePost) => postNotice(ports.operations, notice),
  shareBack: (thread: string, text: string, requestId: string) => shareBack(core, ports, { thread, text, requestId }),
  announce: (thread: string) => announce(core, ports.operations, thread),
  writeEntry: (chat: string, requestId: string, entry: EntryDraft) =>
    Effect.map(ports.operations.passiveWrite(chat, { requestId, entry }), (submission) => ({
      placed: placedOf(submission),
    })).pipe(Effect.withSpan('Conversations.writeEntry')),
  /** Names an untitled thread from its latest exchange with the cheap model; once at a time per thread. */
  nameIfUntitled: (thread: string) =>
    Effect.suspend(() => {
      const row = chatRow(core.db, thread)
      if (row?.kind !== 'thread' || row.title !== null) return Effect.void
      return Effect.asVoid(ports.flights.skip(`naming:${thread}`, nameThread(core, ports.namer, thread)))
    }).pipe(Effect.withSpan('Conversations.nameIfUntitled')),
  update: (chat: string, change: UpdateConversation) => update(core, ports.flows, chat, change),
  markRead: (chat: string) => markRead(core, chat),
  close: (chat: string, by: 'owner' | 'done') =>
    closing(ports.flows, { chat, by }, closeChats(core, chat, by), (closed) => closed.length),
  stopSubagents: (chat: string) => stopSubagents(core, chat),
})
