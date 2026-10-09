import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget } from '../budget.ts'
import { Channel } from '../channel/service.ts'
import { Models } from '../models.ts'
import { RoutineControl, RoutineRuns, RoutineUsage, Routines } from '../routines/service.ts'
import { AgentInput } from '../runtime/input.ts'
import * as Legacy from '../services.ts'
import { attempt, attemptSync } from '../services.ts'

type Method<Args extends readonly unknown[], A> = (...args: Args) => A

/** A store method that throws its typed failures, wrapped as `attemptSync` wraps it: an `AppError`, never a defect. */
const trySync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* attemptSync(() => method(...args))
  })

/** An async method, wrapped as `attempt` wraps it. */
const tryAsync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, Promise<A>>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* attempt(() => method(...args))
  })

/** A method with no typed failure: a read or a write callers run with `useSync`, where a throw is a defect. */
const sync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* Effect.sync(() => method(...args))
  })

/** The owner's routines over the started store (services.ts `Routines`), each call wrapped as its callers wrap it. */
const RoutinesAdapter = Layer.effect(
  Routines,
  Effect.gen(function* () {
    const store = yield* Legacy.Routines
    return Routines.of({
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
  }),
)

/** Routine runs over the started run store (services.ts `RoutineRuns`). */
const RoutineRunsAdapter = Layer.effect(
  RoutineRuns,
  Effect.gen(function* () {
    const store = yield* Legacy.RoutineRuns
    return RoutineRuns.of({
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

/** The daily model budget over the started one (services.ts `Budget`). */
const BudgetAdapter = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const budget = yield* Legacy.Budget
    return Budget.of({
      today: tryAsync('Budget.today', budget.today.bind(budget)),
      record: sync('Budget.record', budget.record.bind(budget)),
      require: tryAsync('Budget.require', budget.require.bind(budget)),
    })
  }),
)

/** The model picker over the started one (services.ts `Models`). */
const ModelsAdapter = Layer.effect(
  Models,
  Effect.gen(function* () {
    const models = yield* Legacy.Models
    return Models.of({
      current: sync('Models.current', models.current.bind(models))(),
      choice: sync('Models.choice', models.choice.bind(models))(),
      choose: trySync('Models.choose', models.choose.bind(models)),
    })
  }),
)

/** The Telegram channel over the started one (services.ts `Channel`). */
const ChannelAdapter = Layer.effect(
  Channel,
  Effect.gen(function* () {
    const channel = yield* Legacy.Channel
    return Channel.of({
      status: sync('Channel.status', channel.status.bind(channel))(),
      startCursor: tryAsync('Channel.startCursor', channel.startCursor.bind(channel)),
      enableEvents: sync('Channel.enableEvents', channel.enableEvents.bind(channel)),
      enable: tryAsync('Channel.enable', channel.enable.bind(channel)),
      disable: sync('Channel.disable', channel.disable.bind(channel))(),
      secret: tryAsync('Channel.secret', channel.secret.bind(channel))(),
      track: sync('Channel.track', channel.track.bind(channel)),
      pull: tryAsync('Channel.pull', channel.pull.bind(channel)),
      deliver: tryAsync('Channel.deliver', channel.deliver.bind(channel)),
    })
  }),
)

/**
 * Lane R's services: routines, the Telegram channel, the model budget and the model picker. Until each gets its own
 * implementation they are adapters over the one instance the legacy start made (layers/legacy.ts), never a second one.
 */
export const RoutinesLive = Layer.mergeAll(
  RoutinesAdapter,
  RoutineRunsAdapter,
  RoutineUsageAdapter,
  RoutineControlAdapter,
  BudgetAdapter,
  ModelsAdapter,
  ChannelAdapter,
)
