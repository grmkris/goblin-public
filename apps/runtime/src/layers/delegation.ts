import type {
  CreatePersona,
  CreateTopic,
  HomeEdit,
  HomeTile,
  TopicSeedData,
  UpdatePersona,
  UpdateTopic,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { Home } from '../home/service.ts'
import type { NewReceipt } from '../organize/receipts.ts'
import { Receipts } from '../organize/service.ts'
import type { NewInvocation } from '../personas/invocations.ts'
import type { PersonaActor } from '../personas/registry.ts'
import { Invocations, Personas } from '../personas/service.ts'
import * as Legacy from '../services.ts'
import type { TopicActor } from '../topics/registry.ts'
import { Topics } from '../topics/service.ts'
import { workspaceEventResponse } from '../workspace/feed.ts'
import { Workspace } from '../workspace/service.ts'

/*
 * Lane D's services over the legacy instances (services.ts tags), one instance each: every call is wrapped as the
 * programs wrap it today. A promise goes through `attempt` and a call that can refuse (a missing row, a taken name, a
 * stale revision) through `attemptSync`, both into `AppError`; a plain SQLite read or write runs as it is.
 */

const TopicsAdapter = Layer.effect(
  Topics,
  Effect.gen(function* () {
    const topics = yield* Legacy.Topics
    return Topics.of({
      list: Effect.sync(() => topics.list()).pipe(Effect.withSpan('Topics.list')),
      get: Effect.fn('Topics.get')(function* (id: number) {
        return yield* Legacy.attemptSync(() => topics.get(id))
      }),
      create: Effect.fn('Topics.create')(function* (
        input: CreateTopic,
        actor: TopicActor,
        now: number,
        seed?: TopicSeedData,
      ) {
        return yield* Legacy.attempt(() => topics.create(input, actor, now, seed))
      }),
      update: Effect.fn('Topics.update')(function* (id: number, change: UpdateTopic, now: number) {
        return yield* Legacy.attemptSync(() => topics.update(id, change, now))
      }),
    })
  }),
)

const PersonasAdapter = Layer.effect(
  Personas,
  Effect.gen(function* () {
    const personas = yield* Legacy.Personas
    return Personas.of({
      list: Effect.sync(() => personas.list()).pipe(Effect.withSpan('Personas.list')),
      active: Effect.sync(() => personas.active()).pipe(Effect.withSpan('Personas.active')),
      get: Effect.fn('Personas.get')(function* (id: number) {
        return yield* Legacy.attemptSync(() => personas.get(id))
      }),
      byName: Effect.fn('Personas.byName')(function* (name: string) {
        return yield* Effect.sync(() => Option.fromUndefinedOr(personas.byName(name)))
      }),
      detail: Effect.fn('Personas.detail')(function* (id: number) {
        return yield* Legacy.attemptSync(() => personas.detail(id))
      }),
      revision: Effect.fn('Personas.revision')(function* (id: number, revision: number) {
        return yield* Legacy.attemptSync(() => personas.revision(id, revision))
      }),
      offers: Effect.fn('Personas.offers')(function* (model: string | undefined) {
        return yield* Effect.sync(() => personas.offers(model))
      }),
      create: Effect.fn('Personas.create')(function* (input: CreatePersona, actor: PersonaActor, now: number) {
        return yield* Legacy.attemptSync(() => personas.create(input, actor, now))
      }),
      update: Effect.fn('Personas.update')(function* (
        id: number,
        change: UpdatePersona,
        actor: PersonaActor,
        now: number,
      ) {
        return yield* Legacy.attemptSync(() => personas.update(id, change, actor, now))
      }),
    })
  }),
)

const InvocationsAdapter = Layer.effect(
  Invocations,
  Effect.gen(function* () {
    const invocations = yield* Legacy.Invocations
    return Invocations.of({
      insert: Effect.fn('Invocations.insert')(function* (asked: readonly NewInvocation[], now: number) {
        return yield* Effect.sync(() => invocations.insert(asked, now))
      }),
      get: Effect.fn('Invocations.get')(function* (operationId: string, persona: number) {
        return yield* Effect.sync(() => Option.fromUndefinedOr(invocations.get(operationId, persona)))
      }),
      live: Effect.sync(() => invocations.live()).pipe(Effect.withSpan('Invocations.live')),
      of: Effect.fn('Invocations.of')(function* (operationId: string) {
        return yield* Effect.sync(() => invocations.of(operationId))
      }),
      running: Effect.fn('Invocations.running')(function* (operationId: string, persona: number) {
        yield* Effect.sync(() => invocations.running(operationId, persona))
      }),
      settle: Effect.fn('Invocations.settle')(function* (
        operationId: string,
        persona: number,
        state: 'answered' | 'failed' | 'stopped',
        now: number,
        answerEntry?: number,
      ) {
        yield* Effect.sync(() => invocations.settle(operationId, persona, state, now, answerEntry))
      }),
      stopChat: Effect.fn('Invocations.stopChat')(function* (chat: string, now: number) {
        return yield* Effect.sync(() => invocations.stopChat(chat, now))
      }),
    })
  }),
)

const ReceiptsAdapter = Layer.effect(
  Receipts,
  Effect.gen(function* () {
    const receipts = yield* Legacy.Receipts
    return Receipts.of({
      record: Effect.fn('Receipts.record')(function* (input: NewReceipt, now: number) {
        return yield* Legacy.attemptSync(() => receipts.record(input, now))
      }),
      list: Effect.fn('Receipts.list')(function* (limit?: number) {
        return yield* Effect.sync(() => receipts.list(limit))
      }),
      get: Effect.fn('Receipts.get')(function* (id: string) {
        return yield* Legacy.attemptSync(() => receipts.get(id))
      }),
      markUndone: Effect.fn('Receipts.markUndone')(function* (id: string, now: number) {
        return yield* Legacy.attemptSync(() => receipts.markUndone(id, now))
      }),
    })
  }),
)

const HomeAdapter = Layer.effect(
  Home,
  Effect.gen(function* () {
    const home = yield* Legacy.Home
    return Home.of({
      read: Legacy.attemptSync(() => home.read()).pipe(Effect.withSpan('Home.read')),
      layout: Legacy.attemptSync(() => home.layout()).pipe(Effect.withSpan('Home.layout')),
      needsAppVerification: Effect.fn('Home.needsAppVerification')(function* (
        input: HomeEdit,
        actor: HomeTile['placedBy'],
      ) {
        return yield* Legacy.attemptSync(() => home.needsAppVerification(input, actor))
      }),
      edit: Effect.fn('Home.edit')(function* (input: HomeEdit, actor: HomeTile['placedBy']) {
        return yield* Legacy.attemptSync(() => home.edit(input, actor))
      }),
      appRemoved: Legacy.attemptSync(() => home.appRemoved()).pipe(Effect.withSpan('Home.appRemoved')),
    })
  }),
)

const WorkspaceAdapter = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const feed = yield* Legacy.Workspace
    return Workspace.of({
      events: Effect.sync(() => workspaceEventResponse(feed)).pipe(Effect.withSpan('Workspace.events')),
    })
  }),
)

/** Lane D's services: delegation, Topics, Personas, organizing, Home and the workspace feed. */
export const DelegationLive = Layer.mergeAll(
  TopicsAdapter,
  PersonasAdapter,
  InvocationsAdapter,
  ReceiptsAdapter,
  HomeAdapter,
  WorkspaceAdapter,
)
