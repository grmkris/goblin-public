import type { AgentAppChange } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import type { TokenUse } from '../budget-credits.ts'
import { Budget } from '../budget.ts'
import { InvalidInput, NotFound, attempt, attemptSync, toAppError } from '../http/errors.ts'
import { CheapModel, ModelFailed, modelFailureText } from '../memory/model.ts'
import { memoryModelId, modelOptions } from '../models.ts'
import { KeyedLock } from '../observability/lock.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { auxReporter } from '../telemetry/report.ts'
import type { AppDispatch, CallRequest, CallResult } from './dispatch.ts'
import type { AgentApps } from './engine.ts'
import { appDetail, appSummaries } from './manage.ts'
import { type AppCompletion, appServices } from './ports.ts'
import { AppCodeError, appKey, promised, thrownOf } from './queue.ts'
import { AppEngine } from './service.ts'
import { readJobInput } from './stored.ts'

/** A step of the engine in the service's error channel, mapped as the programs' `attempt` did. */

/** Holds an app's lock around a program: the runtime's KeyedLock, under the key the engine's own lock takes. */
type Hold = (app: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/** A call of an app's action or view from inside the runtime: `begin`, then `commit` holding the app's lock. */
const dispatched = (hold: Hold, dispatch: AppDispatch, request: CallRequest) =>
  promised(() => dispatch.begin(request)).pipe(
    Effect.filterOrElse(
      (begun): begun is CallResult => begun.kind !== 'pending',
      (pending) => hold(request.app)(promised(() => dispatch.commit(pending))),
    ),
  )

/** The owner runs a schedule's action now: its run, then how it went as the schedule's last run (never a failure). */
const runJobNow = (hold: Hold, engine: AgentApps, app: string, action: string) =>
  Effect.gen(function* () {
    const { input, op } = yield* attemptSync(() => engine.jobs.startNow(app, action))
    const ran = yield* Effect.exit(
      Effect.flatMap(
        promised(async () => readJobInput(input)),
        (value) => dispatched(hold, engine.dispatch, { app, member: action, input: value, op }),
      ),
    )
    const outcome = Exit.isSuccess(ran) ? { ok: true as const } : { ok: false as const, error: thrownOf(ran.cause) }
    yield* attemptSync(() => engine.jobs.finishNow(app, action, outcome))
  })

/** One change the owner makes to an agent app other than moving its home; the steps that change state hold its lock. */
const changeApp = (
  hold: Hold,
  engine: AgentApps,
  app: string,
  change: Exclude<AgentAppChange, { readonly kind: 'home' }>,
) =>
  Effect.gen(function* () {
    if (engine.store.app(app) === undefined) return yield* new NotFound({ what: `app ${app}` })
    switch (change.kind) {
      case 'rollback':
        yield* hold(app)(attempt(() => engine.held.rollback(app, change.release)))
        return
      case 'pause':
        yield* attempt(() => engine.jobs.pause(app, change.action, change.paused))
        return
      case 'run':
        yield* runJobNow(hold, engine, app, change.action)
        return
      case 'power':
        yield* attemptSync(() => engine.answer(app, { kind: change.power, target: change.target }, change.allowed))
    }
  })

/**
 * `AppEngine` over the agent object's own apps engine (one instance, made before Pi opened, read from `AgentInput`).
 * The owner's state changes hold the app's KeyedLock here, in the runtime; the engine's other callers take the same
 * lock through `local`.
 */
const AppEngineLive = Layer.effect(
  AppEngine,
  Effect.gen(function* () {
    const { agentApps: engine } = yield* AgentInput
    const locks = yield* KeyedLock
    const hold: Hold = (app) => locks.withLock(appKey(app))
    return AppEngine.of({
      info: Effect.fn('AppEngine.info')(function* (name: string) {
        return yield* attemptSync(() => engine.info(name))
      }),
      summaries: attemptSync(() => appSummaries(engine)).pipe(Effect.withSpan('AppEngine.summaries')),
      detail: Effect.fn('AppEngine.detail')(function* (name: string) {
        const now = yield* Clock.currentTimeMillis
        return yield* attempt(() => appDetail(engine, name, now))
      }),
      change: Effect.fn('AppEngine.change')(function* (
        name: string,
        change: Exclude<AgentAppChange, { readonly kind: 'home' }>,
      ) {
        yield* changeApp(hold, engine, name, change)
      }),
      moveHome: Effect.fn('AppEngine.moveHome')(function* (name: string, session: string) {
        yield* attemptSync(() => engine.moveHome(name, session))
      }),
      remove: Effect.fn('AppEngine.remove')(function* (name: string) {
        yield* attemptSync(() => engine.dispatch.active(name))
        yield* hold(name)(attempt(() => engine.held.remove(name)))
      }),
      snapshot: Effect.fn('AppEngine.snapshot')(function* (name: string) {
        return yield* attemptSync(() => engine.snapshot(name))
      }),
      launch: Effect.fn('AppEngine.launch')(function* (name: string) {
        return yield* attemptSync(() => engine.launch(name))
      }),
      viewCall: Effect.fn('AppEngine.viewCall')(function* (name: string, member: string, input: unknown, op: string) {
        const actions = yield* attemptSync(() => engine.dispatch.manifest(engine.dispatch.active(name)).actions)
        if (actions[member] === undefined)
          return yield* new InvalidInput({
            reason: `${name} has no action ${member}; a view calls actions and reads the state`,
          })
        // A view calls actions only; `op` is the frame's operation id, kept apart per app.
        const request = { app: name, member, input, op: `ui:${name}:${op}` }
        const refused = yield* dispatched(hold, engine.dispatch, request).pipe(
          Effect.as(undefined),
          Effect.catchTag('Thrown', ({ cause }) =>
            cause instanceof AppCodeError ? Effect.succeed(cause.message) : Effect.fail(toAppError(cause)),
          ),
        )
        if (refused !== undefined) return { ok: false as const, error: refused }
        return { ok: true as const, ...(yield* attemptSync(() => engine.snapshot(name))) }
      }),
      viewError: Effect.fn('AppEngine.viewError')(function* (name: string, message: string) {
        return yield* attemptSync(() => engine.viewError(name, message))
      }),
    })
  }),
)

/** An app reads a cheap-model failure as the text it always read: an AppCodeError's problemText is its message. */
export const appAnswer = (answer: Promise<string>): Promise<string> =>
  answer.catch((error: unknown) => {
    throw error instanceof ModelFailed ? new AppCodeError(modelFailureText(error)) : error
  })

/** The cheap model's completion for apps (`app_llm`): its tokens are recorded even when its answer fails. */
const completion = (input: AgentInputs): AppCompletion => {
  const { env, pi, telemetry } = input
  const id = memoryModelId(env.MEMORY_MODEL, modelOptions(env.MODELS, env.MODEL_ID))
  const report = auxReporter(telemetry, 'app_llm')
  return (system, prompt, maxTokens) =>
    Effect.gen(function* () {
      const budget = yield* Budget
      const spent: TokenUse[] = []
      const model = new CheapModel(pi.models, id, (use) => void spent.push(use), report)
      const record = Effect.suspend(() =>
        Effect.forEach(spent, (use) =>
          Effect.flatMap(Clock.currentTimeMillis, (millis) => budget.record(use, Math.floor(millis / 1000), id)),
        ),
      )
      return yield* promised(() => appAnswer(model.complete(system, prompt, maxTokens))).pipe(Effect.ensuring(record))
    })
}

/**
 * Gives the engine what the apps' powers reach through the agent, once, while the runtime is built: before any request
 * reaches the engine through it. Pi's tools and job alarms that come before see "the agent is starting".
 */
const ConnectLive = Layer.effectDiscard(
  AgentInput.useSync((input) => input.agentApps.connect(appServices(input.run, completion(input)))),
)

/** Lane A's agent apps services: the engine as `AppEngine`, connected to the agent's services. */
export const AgentAppsLive = Layer.merge(AppEngineLive, ConnectLive)
