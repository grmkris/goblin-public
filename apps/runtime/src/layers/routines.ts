import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { creditRates } from '../budget-credits.ts'
import { telegramChannel } from '../channel/channel.ts'
import { Channel } from '../channel/service.ts'
import { attempt, attemptSync } from '../http/errors.ts'
import { Cipher } from '../mcp/cipher.ts'
import { type RoutineControlServices, makeRoutineControl } from '../routines/control.ts'
import type { RoutineRunStore } from '../routines/runs.ts'
import { RoutineRunStore as RunStore } from '../routines/runs.ts'
import { RoutineControl, RoutineRuns, RoutineUsage, Routines } from '../routines/service.ts'
import { RoutineStore } from '../routines/store.ts'
import { RoutineUsage as UsageProjection, installRoutineUsage } from '../routines/usage.ts'
import { Notices } from '../notices/service.ts'
import { KEPT_NOTICES, NoticeStore, notificationOf } from '../notices/store.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

type Method<Args extends readonly unknown[], A> = (...args: Args) => A

/** A store method that throws its typed failures: an `AppError` (anything else `Internal`), never a defect. */
const trySync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* attemptSync(() => method(...args))
  })

/** An async method, its rejection an `AppError` the same way. */
const tryAsync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, Promise<A>>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* attempt(() => method(...args))
  })

/** A method with no typed failure: a read or a write callers run with `useSync`, where a throw is a defect. */
const sync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* Effect.sync(() => method(...args))
  })

/** The owner's routines over `store`, a synchronous Drizzle repository wrapped once here. */
export const routinesOf = (store: RoutineStore) =>
  Routines.of({
    list: sync('Routines.list', store.list.bind(store)),
    get: trySync('Routines.get', store.get.bind(store)),
    view: trySync('Routines.view', store.view.bind(store)),
    topicOf: sync('Routines.topicOf', store.topicOf.bind(store)),
    propose: trySync('Routines.propose', store.propose.bind(store)),
    edit: trySync('Routines.edit', store.edit.bind(store)),
    confirm: trySync('Routines.confirm', store.confirm.bind(store)),
    confirmAgain: trySync('Routines.confirmAgain', store.confirmAgain.bind(store)),
    pause: trySync('Routines.pause', store.pause.bind(store)),
    archive: trySync('Routines.archive', store.archive.bind(store)),
    halt: trySync('Routines.halt', store.halt.bind(store)),
    markActive: trySync('Routines.markActive', store.markActive.bind(store)),
    settings: sync('Routines.settings', store.settings.bind(store))(),
    updateSettings: trySync('Routines.updateSettings', store.settingsUpdate.bind(store)),
    scheduling: sync('Routines.scheduling', store.scheduling.bind(store))(),
    eventHealth: sync('Routines.eventHealth', store.eventHealth.bind(store)),
    advance: trySync('Routines.advance', store.advance.bind(store)),
    pending: sync('Routines.pending', store.pending.bind(store)),
    queue: trySync('Routines.queue', store.queue.bind(store)),
    clearPending: trySync('Routines.clearPending', store.clearPending.bind(store)),
  })

/** The routines' notices over `store` (ADR 0041), a synchronous Drizzle repository wrapped once here. */
export const noticesOf = (store: NoticeStore) =>
  Notices.of({
    claim: trySync('Notices.claim', store.claim.bind(store)),
    get: sync('Notices.get', store.get.bind(store)),
    written: trySync('Notices.written', store.written.bind(store)),
    digestsDue: trySync('Notices.digestsDue', store.digestsDue.bind(store)),
    unwritten: sync('Notices.unwritten', store.unwritten.bind(store)),
    prune: trySync('Notices.prune', store.prune.bind(store)),
    telegramDue: sync('Notices.telegramDue', store.telegramDue.bind(store)),
    claimTelegram: sync('Notices.claimTelegram', store.claimTelegram.bind(store)),
    telegramDone: sync('Notices.telegramDone', store.telegramDone.bind(store)),
    views: Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => store.recent(now - KEPT_NOTICES, 100).map(notificationOf)),
    ),
    view: (id) =>
      Effect.sync(() => {
        const row = store.get(id)
        return row === undefined ? undefined : notificationOf(row)
      }),
    read: trySync('Notices.read', store.read.bind(store)),
  })

/** Routine runs over `store`, wrapped once here. */
export const routineRunsOf = (store: RoutineRunStore) =>
  RoutineRuns.of({
    ask: tryAsync('RoutineRuns.ask', store.ask.bind(store)),
    resume: trySync('RoutineRuns.resume', store.resume.bind(store)),
    get: trySync('RoutineRuns.get', store.get.bind(store)),
    session: sync('RoutineRuns.session', store.session.bind(store)),
    list: trySync('RoutineRuns.list', store.list.bind(store)),
    live: sync('RoutineRuns.live', store.live.bind(store))(),
    unfinishedReports: sync('RoutineRuns.unfinishedReports', store.unfinishedReports.bind(store))(),
    claim: trySync('RoutineRuns.claim', store.claim.bind(store)),
    bind: trySync('RoutineRuns.bind', store.bind.bind(store)),
    settle: trySync('RoutineRuns.settle', store.settle.bind(store)),
    reported: sync('RoutineRuns.reported', store.reported.bind(store)),
    used: trySync('RoutineRuns.used', store.used.bind(store)),
    recordUsage: sync('RoutineRuns.recordUsage', store.recordUsage.bind(store)),
  })

/**
 * Start step 6: routine runs over the agent's SQLite, and their usage projection subscribed to Pi's commits once,
 * after a snapshot of each live run, before anything after it in the start can commit to Pi. The run store is built
 * once, here, for both.
 */
export const RoutineRunsLive: Layer.Layer<RoutineRuns | RoutineUsage, never, AgentInput | Db> = Layer.effectContext(
  Effect.gen(function* () {
    const { env, harness, userId } = yield* AgentInput
    const db = yield* Db
    const runs = new RunStore(db, userId)
    const projection = new UsageProjection(db, runs, creditRates(env.MODEL_CREDIT_RATES), harness)
    yield* Effect.promise(() => installRoutineUsage(harness, projection, runs))
    const usage = RoutineUsage.of({
      project: trySync('RoutineUsage.project', projection.project.bind(projection)),
      snapshot: tryAsync('RoutineUsage.snapshot', projection.snapshot.bind(projection)),
    })
    return Context.make(RoutineRuns, routineRunsOf(runs)).pipe(Context.add(RoutineUsage, usage))
  }),
)

/**
 * Start step 11: the Telegram channel, the one instance, over the agent's database and the credential cipher, with its
 * pull's own semaphore.
 */
export const ChannelLive: Layer.Layer<Channel, never, AgentInput | Db | Cipher> = Layer.effect(
  Channel,
  Effect.gen(function* () {
    const { scheduleReplies, telemetry } = yield* AgentInput
    const db = yield* Db
    return yield* telegramChannel({
      db,
      cipher: yield* Cipher,
      telemetry,
      wake: scheduleReplies,
    })
  }),
)

/**
 * The owner's routines and their runtime, after the start: the routine store, built once here over the agent's SQLite
 * and wrapped as `Routines`, and the native `RoutineControl` over it, which registers the routine trigger with Events.
 * Routine runs (start step 6) and the Telegram channel (11) are start steps above.
 */
export const RoutinesLive: Layer.Layer<
  Routines | RoutineControl | Notices,
  never,
  Exclude<RoutineControlServices, Routines | Notices> | Db
> = Layer.effectContext(
  Effect.gen(function* () {
    const { userId } = yield* AgentInput
    const db = yield* Db
    const store = new RoutineStore(db, userId)
    const routines = routinesOf(store)
    const notices = noticesOf(new NoticeStore(db))
    const control = yield* makeRoutineControl(store).pipe(
      Effect.provideService(Routines, routines),
      Effect.provideService(Notices, notices),
    )
    return Context.make(Routines, routines).pipe(Context.add(RoutineControl, control), Context.add(Notices, notices))
  }),
)
