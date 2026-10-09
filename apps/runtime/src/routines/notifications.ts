import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Entitlements, type EntitlementPolicy } from '../billing/gates.ts'
import type { ResidentAuthority } from '../resident.ts'
import { nowSeconds } from '../clock.ts'
import { Forbidden } from '../http/errors.ts'
import { reportFailure } from '../observability/report.ts'
import { Channel, Mcp, Resident, RoutineRuns, attempt, attemptSync, requireResident } from '../services.ts'
import { definitionOf, type RoutineRun } from './runs.ts'

const Receipt = Schema.Struct({
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  delivery: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
})
const authority = Effect.gen(function* () {
  yield* Entitlements.use((plans) => plans.require('routines'))
  yield* requireResident
})
const dispatchAuthority =
  (plans: EntitlementPolicy, resident: ResidentAuthority, channel: () => boolean) => async () => {
    await Effect.runPromise(plans.require('routines'))
    resident.require(nowSeconds())
    if (!channel()) throw new Forbidden({ reason: 'routine notification channel changed' })
  }
type Delivery = { state: 'accepted' | 'suppressed' | 'pending'; receipt: string | null }
const suppress = () => Effect.succeed<Delivery>({ state: 'suppressed', receipt: null })

/** The confirmed report is service plumbing; acceptance and the remote delivery receipt remain separate. */
export const notifyRoutine = (record: RoutineRun) =>
  Effect.gen(function* () {
    const store = yield* RoutineRuns
    const plans = yield* Entitlements
    const resident = yield* Resident
    const at = yield* Clock.currentTimeMillis
    if (!definitionOf(record).notifyTelegram || record.notificationText === null) return
    const text = record.notificationText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const channels = yield* Channel
    const channel = channels.status()
    const serverId = record.notificationServerId ?? channel?.serverId ?? null
    if (record.notificationAttempts >= 5 || at >= record.updatedAt + 900_000) {
      yield* attemptSync(() =>
        store.notification(record.id, {
          serverId,
          state: 'failed',
          receipt: null,
          nextAt: 0,
          attempt: record.notificationAttempts,
        }),
      )
      return
    }
    const claimed = yield* attemptSync(() =>
      store.claimNotification(record.id, record.notificationAttempts, serverId, at),
    )
    if (!claimed) return
    const receipt = yield* Effect.gen(function* () {
      yield* authority
      if (serverId === null || channel?.serverId !== serverId)
        return yield* new Forbidden({ reason: 'routine notification channel changed' })
      const mcp = yield* Mcp
      const result = yield* attempt(() =>
        mcp.manager.callTool(
          serverId,
          'send_message',
          { operationId: `routine-${record.id}-0`, text },
          {
            caller: 'model',
            timeout: 5000,
            authorize: dispatchAuthority(plans, resident, () => channels.status()?.serverId === serverId),
          },
        ),
      )
      if (result.isError === true) return yield* new Forbidden({ reason: 'routine notification refused' })
      const metadata = yield* attemptSync(() => Schema.decodeUnknownSync(Receipt)(result.structuredContent ?? {}))
      return JSON.stringify({
        operationId: `routine-${record.id}-0`,
        ...metadata,
      })
    }).pipe(
      Effect.map((value): Delivery => ({ state: 'accepted', receipt: value })),
      Effect.catchTags({ ResidentInactive: suppress, SubscriptionRequired: suppress, Forbidden: suppress }),
      reportFailure('routines.notify'),
      // expected: reported above; a failed delivery is tried again with backoff and is failed after five attempts.
      Effect.catch(() => Effect.succeed<Delivery>({ state: 'pending', receipt: null })),
    )
    const attempts = record.notificationAttempts + 1
    yield* attemptSync(() =>
      store.notification(record.id, {
        serverId,
        receipt: receipt.receipt,
        state:
          receipt.state === 'pending' && (attempts >= 5 || at >= record.updatedAt + 900_000) ? 'failed' : receipt.state,
        attempt: attempts,
        nextAt: at + Math.min(15_000 * 2 ** attempts, 300_000),
      }),
    )
  })
