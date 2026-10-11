import { type NoticeData, type RoutineDefinition, handOverOf } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Channel } from '../channel/service.ts'
import { Conversations } from '../chats/service.ts'
import { McpServers } from '../mcp/service.ts'
import { Notices } from '../notices/service.ts'
import { type DigestDue, NOTICE_WINDOW, type NewNotice, type NoticeRow } from '../notices/store.ts'
import { type NoticeText, noticeForModel, noticeOfEvent } from '../notices/text.ts'
import { Routines } from './service.ts'
import { type RoutineRow, definitionOf } from './store.ts'

/** How long Activity keeps a notification (ms). */
const KEPT = 30 * 86_400_000

/** A notice's data as its entry keeps it, from its row (ADR 0041). */
const noticeData = (row: NoticeRow, source: NoticeData['source']): NoticeData => ({
  notice: row.id,
  routine: row.routineId,
  source,
  from: { label: row.label, ...(row.connectionId === null ? {} : { connectionId: row.connectionId }) },
  title: row.title,
  ...(row.body === null ? {} : { body: row.body }),
  ...(row.url === null ? {} : { url: row.url }),
})

/** The words a notice's Telegram copy says: who it is from, its title and its link, frozen when it is claimed. */
const telegramText = (label: string, text: NoticeText): string =>
  [`${label}: ${text.title}`, text.body, text.url].filter((part) => part !== undefined).join('\n')

/** Writes notice `id`'s entry into the chat it was claimed for, once, and marks it written. */
export const writeNotice = Effect.fn('routines.writeNotice')(function* (id: string) {
  const notices = yield* Notices
  const row = yield* notices.get(id)
  if (row === undefined || row.writtenAt !== null) return
  const now = yield* Clock.currentTimeMillis
  // An answer's notification points at its report, which is already written.
  if (row.source === 'report') return yield* notices.written(id, now)
  const data = noticeData(row, row.source)
  const said = {
    title: row.title,
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.url === null ? {} : { url: row.url }),
  }
  const text = noticeForModel(row.label, said, row.source === 'reminder')
  yield* (yield* Conversations).postNotice({ chat: row.chatId, requestId: row.entryRequestId, data, text, at: row.at })
  yield* notices.written(id, yield* Clock.currentTimeMillis)
})

/** Claims `notice` (counted into its routine's hour when `capped`), then writes it and the digest an hour ended with. */
const post = Effect.fn('routines.postNotice')(function* (notice: NewNotice, capped: boolean) {
  const claim = yield* (yield* Notices).claim(notice, capped)
  if (claim.digest !== undefined) yield* postDigest(claim.digest)
  if (claim.posted) yield* writeNotice(notice.id)
})

/** A notice that is not counted into an hour (a reminder, a digest): kept once and written. */
const postUncounted = Effect.fn('routines.postUncounted')(function* (notice: NewNotice) {
  if ((yield* (yield* Notices).claim(notice, false)).posted) yield* writeNotice(notice.id)
})

/** The connection a routine's event comes from, as the owner named it; its id when it has no label. */
const labelOf = Effect.fn('routines.connectionLabel')(function* (connectionId: string) {
  return (yield* (yield* McpServers).labels()).get(connectionId) ?? connectionId
})

/** A routine as far as where it posts: its id and its Topic. */
type RoutineHome = Pick<RoutineRow, 'id' | 'topicId'>

/** Where routine `row` posts, and the notice fields every notice of it shares. */
const base = Effect.fn('routines.noticeBase')(function* (row: RoutineHome, id: string, at: number) {
  const home = yield* (yield* Conversations).routineHome(row.topicId)
  const now = yield* Clock.currentTimeMillis
  return { id, routineId: row.id, chatId: home.chat, entryRequestId: id, at, createdAt: now }
})

/**
 * An event's notice (Tell me, ADR 0041): its text from the producer's convention, attributed to the connection, counted
 * into the routine's hour of notices. A replayed delivery finds the notice already claimed and posts nothing again.
 */
export const postEventNotice = Effect.fn('routines.eventNotice')(function* (
  row: RoutineRow,
  definition: RoutineDefinition,
  event: { readonly eventId: string; readonly name: string; readonly data: unknown; readonly occurredAt: number },
) {
  if (definition.trigger.kind !== 'event') return
  const { connectionId } = definition.trigger
  const label = yield* labelOf(connectionId)
  const text = noticeOfEvent(event.name, event.data, label)
  // The Telegram connection's own events never go back to Telegram.
  const echo = (yield* Channel.use((channel) => channel.status))?.connectionId === connectionId
  const id = `notice:${row.id}:${encodeURIComponent(event.eventId)}`
  const notice: NewNotice = {
    ...(yield* base(row, id, event.occurredAt)),
    source: 'event',
    connectionId,
    label,
    title: text.title,
    body: text.body ?? null,
    url: text.url ?? null,
    ...(definition.tellMe.telegram && !echo ? { telegramText: telegramText(label, text) } : {}),
  }
  yield* post(notice, true)
})

/** A schedule's reminder (Tell me with no hand-over): the routine's title, from the routine, at its slot. */
export const postReminder = Effect.fn('routines.reminder')(function* (
  row: RoutineRow,
  definition: RoutineDefinition,
  firedAt: number,
) {
  const id = `notice:${row.id}:${String(firedAt)}`
  const text = { title: definition.title }
  const notice: NewNotice = {
    ...(yield* base(row, id, firedAt)),
    source: 'reminder',
    connectionId: null,
    label: definition.title,
    title: definition.title,
    body: null,
    url: null,
    ...(definition.tellMe.telegram ? { telegramText: telegramText(definition.title, text) } : {}),
  }
  yield* postUncounted(notice)
})

/**
 * The answer of a hand-over the owner asked to be told about: a notification that points at the report already
 * written in the routine's Topic (its entry is the report), never another entry.
 */
export const notifyReport = Effect.fn('routines.notifyReport')(function* (
  row: RoutineHome,
  definition: RoutineDefinition,
  report: { readonly runId: string; readonly text: string; readonly at: number },
) {
  if (!definition.tellMe.on || handOverOf(definition) === undefined) return
  const id = `notice-report:${report.runId}`
  const notice: NewNotice = {
    ...(yield* base(row, id, report.at)),
    entryRequestId: `routine-report:${report.runId}`,
    source: 'report',
    connectionId: null,
    label: definition.title,
    title: report.text.split('\n')[0]?.slice(0, 200) ?? definition.title,
    body: null,
    url: null,
    ...(definition.tellMe.telegram ? { telegramText: `${definition.title}: ${report.text.slice(0, 500)}` } : {}),
  }
  const notices = yield* Notices
  const claim = yield* notices.claim(notice, false)
  if (claim.posted) yield* notices.written(id, notice.createdAt)
})

/** Routine `id` with its definition; none for a routine the agent no longer has. */
const routineOf = Effect.fn('routines.noticeRoutine')(function* (id: string) {
  const found = yield* (yield* Routines).get(id).pipe(
    Effect.map(Option.some),
    Effect.catchTag('NotFound', () => Effect.succeedNone),
  )
  return Option.match(found, {
    onNone: () => undefined,
    onSome: (row) => ({ row, definition: definitionOf(row) }),
  })
})

/** One line for the notices an hour folded past its cap: "+N more from <label>". */
const postDigest = Effect.fn('routines.noticeDigest')(function* (due: DigestDue) {
  const routine = yield* routineOf(due.routineId)
  if (routine === undefined) return
  const { row: routineRow, definition } = routine
  const label = definition.trigger.kind === 'event' ? yield* labelOf(definition.trigger.connectionId) : definition.title
  const id = `notice-digest:${due.routineId}:${String(due.startedAt)}`
  const notice: NewNotice = {
    ...(yield* base(routineRow, id, due.startedAt + NOTICE_WINDOW)),
    source: 'digest',
    connectionId: definition.trigger.kind === 'event' ? definition.trigger.connectionId : null,
    label,
    title: `+${String(due.folded)} more from ${label}`,
    body: null,
    url: null,
  }
  yield* postUncounted(notice)
})

/**
 * The notices' share of the routines' sweep: the digests ended hours owe, the notices claimed but not yet written (a
 * write cut short), and those older than Activity keeps.
 */
export const sweepNotices = Effect.gen(function* () {
  const notices = yield* Notices
  const now = yield* Clock.currentTimeMillis
  for (const due of yield* notices.digestsDue(now)) yield* postDigest(due)
  for (const row of yield* notices.unwritten()) yield* writeNotice(row.id)
  yield* notices.prune(now - KEPT)
})
