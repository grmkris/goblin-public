import type { RoutineDefinition } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import { type AppError, Conflict, attempt, isAppError } from '../http/errors.ts'
import { Cipher } from '../mcp/cipher.ts'
import type { EventContext } from '../mcp/events/dispatcher.ts'
import { type Consumer, canonicalArguments } from '../mcp/events/store.ts'
import { redactSecretFields } from '../mcp/redaction.ts'
import { Events } from '../mcp/service.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { admit, wakeIn } from './runner.ts'
import type { Firing } from './runs.ts'
import { Routines } from './service.ts'
import { type RoutineRow, type RoutineStore, definitionOf } from './store.ts'
import { routineSummary } from './summary.ts'

// The shared Events dispatcher owns delivery (the 'routine-trigger' handler); these are only confirmed routine
// admission and sealed pending metadata.

type Trigger = RoutineDefinition['trigger']
type EventTrigger = Extract<Trigger, { kind: 'event' }>

const consumerId = (id: string) => `routine:${id}`
const live = (state: RoutineRow['state']) => state === 'active' || state === 'activating'
const DAY = 86_400_000

/**
 * Whether subscribing a confirmed event routine failed for a reason the owner has to act on: the server needs signing
 * in again, the selector is not granted or does not exist, or the server refused (anything but a transport failure).
 * Anything else is transient: the routine stays activating and the next sweep tries again.
 */
export const activationRefused = (error: unknown): boolean =>
  isAppError(error) &&
  Match.value(error).pipe(
    Match.tags({
      NeedsAuthorization: () => true,
      GrantDenied: () => true,
      NotFound: () => true,
      UpstreamMcp: (upstream) => upstream.reason !== 'transport',
    }),
    Match.orElse(() => false),
  )

const conflict = (reasons: readonly string[]) => (error: AppError) =>
  error instanceof Conflict && reasons.includes(error.reason)
/** The routine is at a cap: the occurrence waits, sealed, for the next sweep. */
const busy = conflict(['routine already running', 'running routine limit', 'event run spacing limit'])
/** The routine changed since the delivery was bound to it: the occurrence is dropped. */
const inactive = conflict(['routine is not active at this revision'])

/** The routine trigger's subscription for `row`'s revision of `trigger`. */
const subscription = (row: Pick<RoutineRow, 'id' | 'revision'>, trigger: EventTrigger) => ({
  consumerId: consumerId(row.id),
  revision: row.revision,
  connectionId: trigger.connectionId,
  name: trigger.name,
  arguments: trigger.arguments,
  handlerKey: 'routine-trigger',
})

/** Subscribes a confirmed event routine's revision; only the owner's exact-revision Confirm calls it. */
export const confirmEvents = Effect.fn('routines.confirmEvents')(function* (id: string, revision: number) {
  const routines = yield* Routines
  const row = yield* routines.get(id)
  if (row.revision !== revision || row.state !== 'activating' || row.confirmedAt === null) return
  const trigger = definitionOf(row).trigger
  if (trigger.kind !== 'event') return
  const events = yield* Events
  yield* events.grant(trigger.connectionId, trigger.name, trigger.arguments, true)
  yield* events.subscribe(subscription(row, trigger))
  yield* routines.markActive(id, revision, null, yield* Clock.currentTimeMillis)
})

/** A bound revision whose lease ended pauses for the owner to review; one whose lease is active is active. */
const checkLease = (row: RoutineRow, binding: Consumer) =>
  Effect.gen(function* () {
    const events = yield* Events
    const routines = yield* Routines
    const lease = Option.getOrUndefined(yield* events.subscription(binding.subscriptionId))
    const at = yield* Clock.currentTimeMillis
    if (lease?.status === 'terminated' || lease?.status === 'tombstone') {
      yield* routines.pause(row.id, row.revision, `event-ended:${row.id}:${row.revision}`, at)
      yield* routines.eventHealth(
        row.id,
        row.revision + 1,
        'Event subscription ended; review and confirm to reconnect.',
        at,
      )
      yield* events.unsubscribe(binding)
    } else if (lease?.status === 'active') yield* routines.markActive(row.id, row.revision, null, at)
  })

/**
 * Subscribes a live revision that has no binding yet. A refusal the owner must act on is shown as the routine's event
 * health; anything else is logged, and the next sweep tries again.
 */
const activate = (row: RoutineRow, trigger: EventTrigger) =>
  Effect.gen(function* () {
    const events = yield* Events
    const routines = yield* Routines
    yield* events.subscribe(subscription(row, trigger))
    const current = yield* routines.get(row.id)
    if (current.revision !== row.revision || !live(current.state)) {
      yield* events.unsubscribe({ consumerId: consumerId(row.id), revision: row.revision })
      return
    }
    yield* routines.markActive(row.id, row.revision, null, yield* Clock.currentTimeMillis)
  }).pipe(
    Effect.catch((error) =>
      activationRefused(error)
        ? Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Routines.use((routines) =>
              routines.eventHealth(
                row.id,
                row.revision,
                'Event activation needs the connected server and exact event selector.',
                at,
              ),
            ),
          )
        : Effect.sync(() =>
            writeLine('warn', {
              event: 'failure',
              where: 'routines.events.activate',
              'error.type': safeErrorType(error),
            }),
          ),
    ),
  )

/** One routine's Events binding: a stale one retired, a live revision's lease checked or subscribed. */
const repair = Effect.fn('routines.repairBinding')(function* (row: RoutineRow) {
  const events = yield* Events
  const binding = Option.getOrUndefined(yield* events.activeConsumer(consumerId(row.id)))
  const { trigger } = definitionOf(row)
  if (binding !== undefined && (binding.revision !== row.revision || !live(row.state)))
    yield* events.unsubscribe(binding)
  if (trigger.kind !== 'event' || !live(row.state) || row.confirmedAt === null) return
  if (binding?.revision === row.revision) return yield* checkLease(row, binding)
  yield* activate(row, trigger)
})

/** The Events subscriptions repaired to match the stored routines. */
export const reconcileEvents = Effect.gen(function* () {
  for (const row of yield* (yield* Routines).scheduling) yield* repair(row)
})

/** Whether `context` is still a delivery for the routine's active revision of exactly this event selector. */
const current = (row: RoutineRow, trigger: Trigger, context: EventContext) =>
  row.state === 'active' &&
  row.revision === context.consumer.revision &&
  trigger.kind === 'event' &&
  trigger.connectionId === context.subscription.connectionId &&
  trigger.name === context.subscription.name &&
  canonicalArguments(trigger.arguments) === context.subscription.argumentsJson

/**
 * One event occurrence as a firing, its selected metadata sealed for the run's prompt. A busy routine keeps it sealed
 * as the routine's pending trigger, in one short transaction with this consumer's acknowledgement (`store`'s write).
 */
const occurrence = (store: RoutineStore, row: RoutineRow, context: EventContext) =>
  Effect.gen(function* () {
    const envelope = context.envelope
    if ('type' in envelope || envelope.name !== context.subscription.name) return
    const operationId = `routine:${row.id}:${encodeURIComponent(envelope.eventId)}`
    const at = yield* Clock.currentTimeMillis
    const occurredAt = Date.parse(envelope.timestamp)
    const data = JSON.stringify(
      redactSecretFields({ name: envelope.name, timestamp: envelope.timestamp, data: envelope.data }),
    )
    const cipher = yield* Cipher
    const selected = routineSummary(data).slice(0, 8000)
    const dataSealed = yield* attempt(() => cipher.encrypt(selected, `routine-event:${operationId}:${row.revision}`))
    const firing: Firing = {
      routineId: row.id,
      revision: row.revision,
      operationId,
      source: 'event',
      firedAt: at,
      event: {
        eventId: envelope.eventId,
        subscriptionId: context.subscription.id,
        webhookId: context.receipt.webhookId,
        dataSealed,
      },
    }
    const hold = Effect.gen(function* () {
      const pending = yield* attempt(() =>
        cipher.encrypt(JSON.stringify(firing), `routine-pending:${row.id}:${row.revision}`),
      )
      yield* wakeIn(60_000)
      const now = yield* Clock.currentTimeMillis
      yield* (yield* Events).ackWith(context.receipt, () => store.pending(row.id, row.revision, pending, now))
    })
    const stale = !Number.isFinite(occurredAt) || occurredAt < at - DAY
    yield* admit(firing, stale ? 'Event is invalid or older than the 24-hour catch-up window' : undefined).pipe(
      // expected: a busy routine holds the occurrence as its pending trigger, acknowledged with it
      Effect.catchIf(busy, () => hold),
      // expected: the routine changed since the delivery was bound to it, so the occurrence is not its to run
      Effect.catchIf(inactive, () => Effect.void),
    )
  })

/**
 * The routine trigger's handler: a delivery for a routine's active revision fires it, a terminated subscription
 * pauses it for the owner to review, and a gap shows as catching up. `store` writes a busy routine's pending trigger
 * inside the acknowledgement's transaction.
 */
export const consumeEvent = (store: RoutineStore, context: EventContext) =>
  Effect.gen(function* () {
    const id = context.consumer.consumerId.slice('routine:'.length)
    const routines = yield* Routines
    const found = yield* routines.get(id).pipe(
      Effect.map(Option.some),
      Effect.catchTag('NotFound', () => Effect.succeedNone),
    )
    if (Option.isNone(found)) return
    const row = found.value
    const trigger = definitionOf(row).trigger
    if (!current(row, trigger, context)) return
    if (!('type' in context.envelope)) return yield* occurrence(store, row, context)
    const at = yield* Clock.currentTimeMillis
    if (context.envelope.type === 'terminated') {
      yield* routines.pause(id, row.revision, `event-terminated:${context.receipt.operationId}`, at)
      yield* routines.eventHealth(
        id,
        row.revision + 1,
        'Event subscription terminated; review and confirm to reconnect.',
        at,
      )
    } else if (context.envelope.type === 'gap')
      yield* routines.eventHealth(id, row.revision, 'Catching up through the originating event selector.', at)
    yield* wakeIn(1000)
  })
