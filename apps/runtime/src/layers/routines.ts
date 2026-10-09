import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Entitlements, cachedPolicy } from '../billing/gates.ts'
import { Budget, UsageStore, utcDay } from '../budget.ts'
import { creditRates, milliCredits, totalTokens } from '../budget-credits.ts'
import { Channel } from '../channel/service.ts'
import { BudgetExhausted, toAppError } from '../http/errors.ts'
import { ModelChoiceStore, ModelPicker, Models, modelOptions } from '../models.ts'
import type { RoutineRunStore } from '../routines/runs.ts'
import { RoutineRunStore as RunStore } from '../routines/runs.ts'
import { RoutineControl, RoutineRuns, RoutineUsage, Routines } from '../routines/service.ts'
import { RoutineStore } from '../routines/store.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import * as Legacy from '../services.ts'

type Method<Args extends readonly unknown[], A> = (...args: Args) => A

/** A store method that throws its typed failures: an `AppError` (anything else `Internal`), never a defect. */
const trySync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* Effect.try({ try: () => method(...args), catch: toAppError })
  })

/** An async method, its rejection an `AppError` the same way. */
const tryAsync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, Promise<A>>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* Effect.tryPromise({ try: () => method(...args), catch: toAppError })
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

/** The usage projection the start installed on Pi's commits (services.ts `RoutineUsageProjection`). */
const RoutineUsageAdapter = Layer.effect(
  RoutineUsage,
  Effect.gen(function* () {
    const projection = yield* Legacy.RoutineUsageProjection
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

/**
 * The daily model budget in Credits (ADR 0026) over the agent's usage ledger. The allowance is the plan's, read from
 * the plan the agent keeps (`Entitlements`), so a tool call no longer reads auth D1 each time.
 */
const BudgetLive: Layer.Layer<Budget, never, AgentInput | Db | Entitlements> = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const ledger = new UsageStore(yield* Db)
    const plans = yield* Entitlements
    const { env } = yield* AgentInput
    const rates = creditRates(env.MODEL_CREDIT_RATES)
    const today = Effect.fn('Budget.today')(function* (now: number) {
      const { day, resetsAt } = utcDay(now)
      const { dailyCredits } = yield* plans.require()
      const milli = yield* Effect.try({ try: () => ledger.milliCredits(day), catch: toAppError })
      return { used: milli / 1000, limit: dailyCredits, resetsAt }
    })
    return Budget.of({
      today,
      record: Effect.fn('Budget.record')(function* (use, now, model?: string) {
        const tokens = totalTokens(use)
        if (!Number.isFinite(tokens) || tokens <= 0) return
        yield* Effect.sync(() => ledger.add(utcDay(now).day, tokens, milliCredits(use, model, rates), now))
      }),
      require: Effect.fn('Budget.require')(function* (now) {
        const current = yield* today(now)
        if (current.used >= current.limit)
          return yield* new BudgetExhausted({ limit: current.limit, resetsAt: current.resetsAt })
      }),
    })
  }),
)

/** The model picker over the agent's SQLite: the owner's pick among what the deployment offers. */
const ModelsLive: Layer.Layer<Models, never, AgentInput | Db> = Layer.effect(
  Models,
  Effect.gen(function* () {
    const { env } = yield* AgentInput
    const models = new ModelPicker(new ModelChoiceStore(yield* Db), modelOptions(env.MODELS, env.MODEL_ID))
    return Models.of({
      current: sync('Models.current', models.current.bind(models))(),
      choice: sync('Models.choice', models.choice.bind(models))(),
      choose: trySync('Models.choose', models.choose.bind(models)),
    })
  }),
)

/** The Telegram channel over the started one (services.ts `Channel`). */
export const ChannelAdapter = Layer.effect(
  Channel,
  Effect.gen(function* () {
    const channel = yield* Legacy.Channel
    return Channel.of({
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
  }),
)

/**
 * The account's plan as the agent checks it, an active one kept a minute (`cachedPolicy`). It replaces the legacy
 * start's uncached policy for the bridge, the owner gate and every program that reads `Entitlements` when it runs.
 */
export const EntitlementsLive = Layer.effect(
  Entitlements,
  AgentInput.use((input) => cachedPolicy(input.entitlements)),
)

/**
 * The plan the agent keeps, its daily model budget and the model picker, over the agent's SQLite (they keep no state of
 * their own but the kept plan). A send's admission reads them, so `layers/index.ts` builds them before the conversation
 * layer; they need only the instance input and the database.
 */
export const ModelBudgetLive: Layer.Layer<Entitlements | Budget | Models, never, AgentInput | Db> = Layer.mergeAll(
  Layer.provideMerge(BudgetLive, EntitlementsLive),
  ModelsLive,
)

/**
 * Lane R's other services: routines and the Telegram channel. The stores are built here over the agent's SQLite; they
 * keep no state of their own. Three stay adapters over the one instance that has state: the usage projection the
 * legacy start subscribed to Pi's commits, the Telegram channel the legacy start gave the Events consumers and the
 * apps, and the routine controller the agent's constructor made (`AgentInput.routines`).
 */
export const RoutinesLive = Layer.mergeAll(
  RoutineStoreLive,
  RoutineRunStoreLive,
  RoutineUsageAdapter,
  RoutineControlAdapter,
  ChannelAdapter,
)
