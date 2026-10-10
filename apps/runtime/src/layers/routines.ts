import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { creditRates } from '../budget-credits.ts'
import { TelegramChannel } from '../channel/channel.ts'
import { ChatsInstance } from '../chats/directory.ts'
import { Channel } from '../channel/service.ts'
import { attempt, attemptSync } from '../http/errors.ts'
import { Cipher } from '../mcp/cipher.ts'
import type { RoutineRunStore } from '../routines/runs.ts'
import { RoutineRunStore as RunStore } from '../routines/runs.ts'
import { RoutineControl, RoutineRuns, RoutineUsage, Routines } from '../routines/service.ts'
import { RoutineStore } from '../routines/store.ts'
import { RoutineUsage as UsageProjection, installRoutineUsage } from '../routines/usage.ts'
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

/** A method that is an Effect already: only named for its traces. */
const passThrough =
  <Args extends readonly unknown[], A, E>(name: string, method: Method<Args, Effect.Effect<A, E>>) =>
  (...args: Args) =>
    method(...args).pipe(Effect.withSpan(name))

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
    pause: trySync('Routines.pause', store.pause.bind(store)),
    archive: trySync('Routines.archive', store.archive.bind(store)),
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

/** The owner's routines over the agent's SQLite (the store keeps no state of its own). */
const RoutineStoreLive: Layer.Layer<Routines, never, AgentInput | Db> = Layer.effect(
  Routines,
  Effect.gen(function* () {
    const { userId } = yield* AgentInput
    return routinesOf(new RoutineStore(yield* Db, userId))
  }),
)

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
    notifications: sync('RoutineRuns.notifications', store.notifications.bind(store)),
    notification: sync('RoutineRuns.notification', store.notification.bind(store)),
    claimNotification: sync('RoutineRuns.claimNotification', store.claimNotification.bind(store)),
    used: trySync('RoutineRuns.used', store.used.bind(store)),
    recordUsage: sync('RoutineRuns.recordUsage', store.recordUsage.bind(store)),
  })

/** Routine runs over the agent's SQLite (the store keeps no state of its own). */
const RoutineRunStoreLive: Layer.Layer<RoutineRuns, never, AgentInput | Db> = Layer.effect(
  RoutineRuns,
  Effect.gen(function* () {
    const { userId } = yield* AgentInput
    return routineRunsOf(new RunStore(yield* Db, userId))
  }),
)

/**
 * Start step 9: the routine runs' usage projection, subscribed to Pi's commits once, after a snapshot of each live
 * run, before anything after it in the start can commit to Pi.
 */
export const RoutineUsageLive: Layer.Layer<RoutineUsage, never, AgentInput | Db> = Layer.effect(
  RoutineUsage,
  Effect.gen(function* () {
    const { env, harness, userId } = yield* AgentInput
    const db = yield* Db
    const runs = new RunStore(db, userId)
    const projection = new UsageProjection(db, runs, creditRates(env.MODEL_CREDIT_RATES), harness)
    yield* Effect.promise(() => installRoutineUsage(harness, projection, runs))
    return RoutineUsage.of({
      project: trySync('RoutineUsage.project', projection.project.bind(projection)),
      snapshot: tryAsync('RoutineUsage.snapshot', projection.snapshot.bind(projection)),
    })
  }),
)

/** The agent's one routine controller, which its constructor made (`AgentInput.routines`). */
const RoutineControlAdapter = Layer.effect(
  RoutineControl,
  Effect.gen(function* () {
    const { routines } = yield* AgentInput
    return RoutineControl.of({
      manual: tryAsync('RoutineControl.manual', routines.manual.bind(routines)),
      reconcile: tryAsync('RoutineControl.reconcile', routines.reconcile.bind(routines))(),
      confirmEvents: tryAsync('RoutineControl.confirmEvents', routines.confirmEvents.bind(routines)),
      archive: tryAsync('RoutineControl.archive', routines.archive.bind(routines)),
      stop: tryAsync('RoutineControl.stop', routines.stop.bind(routines)),
      answer: tryAsync('RoutineControl.answer', routines.answer.bind(routines)),
      deadline: tryAsync('RoutineControl.deadline', routines.deadline.bind(routines)),
      fire: tryAsync('RoutineControl.fire', routines.fire.bind(routines)),
      maintain: tryAsync('RoutineControl.maintain', routines.maintain.bind(routines))(),
      consumeEvent: tryAsync('RoutineControl.consumeEvent', routines.consumeEvent.bind(routines)),
    })
  }),
)

/** The Telegram channel over `channel`, the agent's one (or a test's own). */
export const channelOver = (channel: TelegramChannel): Channel['Service'] =>
  Channel.of({
    status: sync('Channel.status', channel.status.bind(channel))(),
    startCursor: passThrough('Channel.startCursor', channel.startCursor.bind(channel)),
    enableEvents: sync('Channel.enableEvents', channel.enableEvents.bind(channel)),
    enable: passThrough('Channel.enable', channel.enable.bind(channel)),
    disable: sync('Channel.disable', channel.disable.bind(channel))(),
    secret: tryAsync('Channel.secret', channel.secret.bind(channel))(),
    track: sync('Channel.track', channel.track.bind(channel)),
    pull: tryAsync('Channel.pull', channel.pull.bind(channel)),
    deliver: tryAsync('Channel.deliver', channel.deliver.bind(channel)),
  })

/** Start step 16: the Telegram channel, the one instance, over the chat directory and the credential cipher. */
export const ChannelLive: Layer.Layer<Channel, never, AgentInput | Db | Cipher | ChatsInstance> = Layer.effect(
  Channel,
  Effect.gen(function* () {
    const { scheduleReplies, telemetry } = yield* AgentInput
    const channel = new TelegramChannel(yield* Db, yield* Cipher, scheduleReplies, telemetry, yield* ChatsInstance)
    return channelOver(channel)
  }),
)

/**
 * Lane R's services after the start: the routine stores, built here over the agent's SQLite (they keep no state of
 * their own), and the routine controller the agent's constructor made (`AgentInput.routines`). The usage projection
 * (start step 9) and the Telegram channel (16) are start steps above.
 */
export const RoutinesLive: Layer.Layer<Routines | RoutineRuns | RoutineControl, never, AgentInput | Db> =
  Layer.mergeAll(RoutineStoreLive, RoutineRunStoreLive, RoutineControlAdapter)
