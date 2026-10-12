import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { requirePlan } from '../billing/gates.ts'
import { channelToolName } from '../channel/channel.ts'
import { Channel } from '../channel/service.ts'
import { Forbidden, toAppError } from '../http/errors.ts'
import { McpConnections, requireResident } from '../mcp/service.ts'
import { reportFailure } from '../observability/report.ts'
import { bound } from '../runtime/boundary.ts'
import { sha256Hex } from '../runtime/digest.ts'
import { Notices } from './service.ts'
import type { NoticeRow } from './store.ts'

/** How many attempts a Telegram copy gets, and for how long after its notice it may still go (ADR 0041). */
const ATTEMPTS = 5
const WINDOW = 900_000

const Receipt = Schema.Struct({
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  delivery: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
})
const authority = Effect.gen(function* () {
  yield* requirePlan('routines')
  yield* requireResident
})
/** Checked again right before the call leaves: the plan, resident authority, and that the channel is still `connectionId`. */
const stillAuthorized = (connectionId: string) =>
  Effect.gen(function* () {
    yield* authority
    if ((yield* Channel.use((channel) => channel.status))?.connectionId !== connectionId)
      return yield* new Forbidden({ reason: 'notice channel changed' })
  })
type Delivery = { readonly state: 'accepted' | 'suppressed' | 'pending'; readonly receipt: string | null }
const suppress = () => Effect.succeed<Delivery>({ state: 'suppressed', receipt: null })

/**
 * One attempt at a notice's Telegram copy (ADR 0041): its frozen words, escaped, through the channel it was first
 * tried on, with a stable operation id so a repeat is the same message. Losing the plan, resident authority or the
 * channel suppresses it; a failure retries with backoff and fails after five attempts or fifteen minutes. The remote
 * receipt is kept apart from acceptance.
 */
const deliver = (row: NoticeRow) =>
  Effect.gen(function* () {
    const notices = yield* Notices
    const at = yield* Clock.currentTimeMillis
    if (row.telegramText === null) return
    const channel = yield* Channel.use((channels) => channels.status)
    const connectionId = row.telegramConnectionId ?? channel?.connectionId ?? null
    if (row.telegramAttempts >= ATTEMPTS || at >= row.createdAt + WINDOW)
      return yield* notices.telegramDone(row.id, {
        state: 'failed',
        receipt: null,
        nextAt: 0,
        attempt: row.telegramAttempts,
      })
    if (!(yield* notices.claimTelegram(row.id, row.telegramAttempts, connectionId, at))) return
    const operationId = `notice-${(yield* Effect.promise(() => sha256Hex(row.id))).slice(0, 32)}`
    const text = row.telegramText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const delivery = yield* Effect.gen(function* () {
      yield* authority
      if (connectionId === null || channel?.connectionId !== connectionId)
        return yield* new Forbidden({ reason: 'notice channel changed' })
      const authorize = yield* bound(stillAuthorized(connectionId))
      const result = yield* McpConnections.use((connections) =>
        Effect.flatMap(channelToolName(connections, connectionId, 'send'), (send) =>
          connections.callTool(
            connectionId,
            send,
            { operationId, text },
            { caller: 'model', timeout: 5000, authorize },
          ),
        ),
      )
      if (result.isError === true) return yield* new Forbidden({ reason: 'notice refused' })
      const metadata = yield* Schema.decodeUnknownEffect(Receipt)(result.structuredContent ?? {}).pipe(
        Effect.mapError(toAppError),
      )
      return JSON.stringify({ operationId, ...metadata })
    }).pipe(
      Effect.map((receipt): Delivery => ({ state: 'accepted', receipt })),
      Effect.catchTags({ ResidentInactive: suppress, SubscriptionRequired: suppress, Forbidden: suppress }),
      reportFailure('notices.telegram'),
      // expected: reported above; a failed attempt is tried again with backoff and fails after five attempts.
      Effect.catch(() => Effect.succeed<Delivery>({ state: 'pending', receipt: null })),
    )
    const attempt = row.telegramAttempts + 1
    const spent = attempt >= ATTEMPTS || at >= row.createdAt + WINDOW
    yield* notices.telegramDone(row.id, {
      state: delivery.state === 'pending' && spent ? 'failed' : delivery.state,
      receipt: delivery.receipt,
      nextAt: at + Math.min(15_000 * 2 ** attempt, 300_000),
      attempt,
    })
  })

/** The Telegram copies due now, each tried once; true when some still wait for a retry. */
export const deliverNoticeCopies = Effect.gen(function* () {
  const due = yield* (yield* Notices).telegramDue(yield* Clock.currentTimeMillis)
  for (const row of due) yield* deliver(row)
  return due.length > 0
})
