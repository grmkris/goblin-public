import { describe, expect, it } from '@effect/vitest'
import type { PiHarness, PiOperationResult } from 'agents/harness/pi'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import { ChatDirectory } from '../src/chats/directory.ts'
import { settledWithin } from '../src/chats/instance.ts'
import type { ChatMover } from '../src/chats/mover.ts'
import { ChatOperations, Chats, Conversations, Moves } from '../src/chats/service.ts'
import type { ConversationRegistry } from '../src/conversations.ts'
import type { FoundationServices } from '../src/layers/core.ts'
import { ConversationLive } from '../src/layers/conversation.ts'
import { Budget } from '../src/budget.ts'
import { Models } from '../src/models.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import type { RoutineController } from '../src/routines/controller.ts'
import { PiFailure, PiSessions } from '../src/pi/sessions.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { Chats as LegacyChats, Conversations as LegacyConversations, Moves as LegacyMoves } from '../src/services.ts'
import { appConversations } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

/** A stand-in implementing only the members these tests reach. */
const fake = <T>(members: Partial<T>): T =>
  // SAFETY: each fake below is given every member the adapters under test call on it.
  members as T

/** What the legacy instances were asked, with the time each was given. */
type Calls = string[]

/** The registry: writes that record what they were given, a Close of `2` and its child, and the notes it prepares. */
const registryOf = (calls: Calls) =>
  fake<ConversationRegistry>({
    markRead: (chat, now) => void calls.push(`read:${chat}@${now}`),
    registerRoutine: (session, runId, _title, now, topic) =>
      void calls.push(`routine:${session}:${runId}@${now}:${topic}`),
    view: async () => undefined,
    announcement: (thread) =>
      thread === '2'
        ? { chat: '1', write: { requestId: 'thread-started:2', entry: { kind: 'app.thread_started', data: {} } } }
        : undefined,
    announced: () => true,
    close: async (chat) => (chat === '2' ? [chat, '5'] : []),
    shareBack: (thread, _note, requestId, at) => ({
      chat: '1',
      write: { requestId, origin: 'agent', entry: { kind: 'app.shared', data: { thread, at } } },
      sharedWith: 'main',
    }),
  })

/** Pi's harness: a conversation's writes, a session's model and a submit, each recorded. */
const harnessOf = (calls: Calls) => {
  const conversation = (id: number) => ({
    submit: async (write: { readonly type: string; readonly requestId: string }) => {
      calls.push(`${write.type}:${id}:${write.requestId}`)
      return { id: 1 }
    },
  })
  return fake<PiHarness>({
    // SAFETY: a passive write asks Pi's harness only for a conversation.
    pi: async () => ({ conversation: async (id: number) => conversation(id) }) as never,
    // SAFETY: a send asks a session only to change its model.
    session: (session: string) =>
      ({ setModel: async ({ id }: { id: string }) => void calls.push(`model:${session}:${id}`) }) as never,
    submit: async (_content, options = {}) => {
      calls.push(`submit:${options.session}:${options.operationId}`)
      return { session: options.session ?? '', operationId: options.operationId ?? '', accepted: true }
    },
  })
}

/**
 * The conversation services over the one legacy instance of each: a real chat directory on SQLite, a registry and a
 * mover that record their calls, Pi's harness for a write, a model choice and a submit, a routine that takes `op-r` as
 * its answer, and the flows recorded. Nothing else the layer captures is read.
 */
const services = (calls: Calls) => {
  const flows: FlowEvent[] = []
  const { db, close } = chatDatabase()
  db.insert(appConversations)
    .values([
      { chatId: '1', piSession: '41', kind: 'main', role: 'primary', createdAt: 1 },
      { chatId: '2', piSession: '42', kind: 'thread', parentSession: '1', createdAt: 1 },
      {
        chatId: '3',
        piSession: '43',
        kind: 'thread',
        parentSession: '1',
        createdAt: 1,
        closedAt: 2,
        closedBy: 'owner',
      },
    ])
    .run()
  const moves = fake<ChatMover>({
    move: async (chat, input, now) => {
      calls.push(`move:${chat}@${now}`)
      return { ...input, chat, mode: 'settled', state: 'refused', reason: 'streaming' }
    },
  })
  const harness = harnessOf(calls)
  const directory = new ChatDirectory(db)
  const registry = registryOf(calls)
  const routines = fake<RoutineController>({ answer: async (_session, operationId) => operationId === 'op-r' })
  const input = Layer.succeed(AgentInput, fake<AgentInputs>({ harness, applied: new Map(), routines }))
  const plans = Layer.mergeAll(
    Layer.succeed(Budget, fake<Budget['Service']>({ require: () => Effect.void })),
    Layer.succeed(Models, fake<Models['Service']>({ current: Effect.succeed('model-a') })),
    FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
  )
  const layer = ConversationLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        // SAFETY: the layer reads only the core services, legacy instances and input given below; the rest stays unprovided.
        Layer.succeedContext(Context.empty() as Context.Context<FoundationServices>),
        // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
        Layer.succeed(Db, db as never),
        KeyedLock.layer,
        PiSessions.layer.pipe(Layer.provide(input)),
        Layer.succeed(LegacyChats, directory),
        Layer.succeed(LegacyConversations, registry),
        Layer.succeed(LegacyMoves, moves),
        input,
        plans,
      ),
    ),
  )
  return {
    layer: Layer.merge(layer, Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(close)))),
    calls,
    directory,
    flows,
  }
}

describe('the conversation services', () => {
  it.effect('resolve chats as the directory does, absence as None and an unknown chat as NotFound', () => {
    const { layer } = services([])
    return Effect.gen(function* () {
      const chats = yield* Chats
      expect(chats.primary).toBe('1')
      expect(yield* chats.session('2')).toBe('42')
      expect(yield* chats.chatOf('41')).toEqual(Option.some('1'))
      expect(yield* chats.chatOf('1')).toEqual(Option.none())
      expect(yield* Effect.flip(chats.session('99'))).toMatchObject({ _tag: 'NotFound' })
      expect(yield* chats.isConversation('1')).toBe(true)
      expect(yield* chats.conversationAbove('2')).toBe('1')
    }).pipe(Effect.provide(layer))
  })

  it.effect('admit an operation once with its receipt, and write passively into the chat it names', () => {
    const { layer, calls } = services([])
    return Effect.gen(function* () {
      const operations = yield* ChatOperations
      yield* TestClock.adjust('20 seconds')
      const send = { kind: 'send', origin: 'owner' } as const
      expect(yield* operations.record('2', 'op-1', send)).toEqual({ session: '42', existing: false })
      expect(yield* operations.record('2', 'op-1', send)).toEqual({ session: '42', existing: true })
      expect(yield* operations.operation('2', 'op-1')).toEqual(Option.some('42'))
      expect(yield* operations.operation('1', 'op-1')).toEqual(Option.none())
      yield* operations.advance('2', 'op-1', { state: 'submitted' })
      expect(yield* operations.receipt('2', 'op-1')).toEqual(
        Option.some({ chat: '2', operationId: 'op-1', session: '42', admittedAt: 20, ...send, state: 'submitted' }),
      )
      const write = { requestId: 'note:1', entry: { kind: 'app.note', data: {} }, parentOp: 'op-1' }
      yield* operations.passiveWrite('2', write)
      expect(calls).toEqual(['write:42:note:1'])
      expect(yield* operations.related('op-1')).toMatchObject([
        { chat: '2', operationId: 'note:1', kind: 'write:app.note', origin: 'system', state: 'written' },
      ])
      expect(yield* Effect.flip(operations.record('99', 'op-2', send))).toMatchObject({ _tag: 'NotFound' })
    }).pipe(Effect.provide(layer))
  })

  it.effect('send an input through the one admission sequence, a replay as replayed and a closed chat refused', () => {
    const { layer, calls, flows } = services([])
    return Effect.gen(function* () {
      const operations = yield* ChatOperations
      const input = {
        chat: '2',
        operationId: 'op-1',
        receipt: { kind: 'send', origin: 'owner' },
        flow: { flow: 'send', via: 'app', actor: 'owner' },
        content: 'hello',
        answers: 'hello',
      } as const
      expect(yield* operations.send(input)).toEqual({ session: '42', operationId: 'op-1', accepted: true })
      yield* operations.send(input)
      yield* operations.send({ ...input, operationId: 'op-r' })
      expect(calls).toEqual(['model:42:model-a', 'submit:42:op-1', 'submit:42:op-1'])
      expect(yield* operations.receipt('2', 'op-1')).toMatchObject(Option.some({ kind: 'send', state: 'submitted' }))
      expect(yield* operations.receipt('2', 'op-r')).toMatchObject(Option.some({ state: 'submitted' }))
      const refused = yield* Effect.flip(operations.send({ ...input, chat: '3', operationId: 'op-2' }))
      expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'conversation_closed' })
      expect(yield* operations.receipt('3', 'op-2')).toEqual(Option.none())
      expect(flows.map(({ flow, chat, operationId, status }) => [flow, chat, operationId, status])).toEqual([
        ['send', '2', 'op-1', 'ok'],
        ['send', '2', 'op-1', 'replayed'],
        ['send', '2', 'op-r', 'ok'],
        ['send', '3', 'op-2', 'refused'],
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("hold a chat's one admission lock, which the legacy directory's callers share, in arrival order", () => {
    const { layer, directory } = services([])
    return Effect.gen(function* () {
      const operations = yield* ChatOperations
      const order: string[] = []
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(
        operations.withChat(
          '2',
          Effect.gen(function* () {
            order.push('first:start')
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            order.push('first:end')
          }),
        ),
      )
      yield* Deferred.await(started)
      const legacy = directory.withChat('2', async () => void order.push('legacy'))
      yield* operations.withChat(
        '1',
        Effect.sync(() => order.push('other chat')),
      )
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Effect.promise(() => legacy)
      expect(order).toEqual(['first:start', 'other chat', 'first:end', 'legacy'])
    }).pipe(Effect.provide(layer))
  })

  it.effect("write a thread's note into the chat it came from with its receipt, as a share flow", () => {
    const { layer, calls, flows } = services([])
    return Effect.gen(function* () {
      const conversations = yield* Conversations
      expect(yield* conversations.shareBack('2', 'note', 'share:call-1')).toBe('main')
      expect(calls).toEqual(['write:41:share:call-1'])
      expect(yield* (yield* ChatOperations).receipt('1', 'share:call-1')).toMatchObject(
        Option.some({ kind: 'write:app.shared', origin: 'agent', state: 'written' }),
      )
      expect(flows).toEqual([
        {
          flow: 'share',
          via: 'tool',
          actor: 'agent',
          chat: '2',
          parentChat: '1',
          operationId: 'share:call-1',
          status: 'ok',
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('record a Close as its close flow, one that closed nothing as a replay', () => {
    const { layer, flows } = services([])
    return Effect.gen(function* () {
      const conversations = yield* Conversations
      expect(yield* conversations.close('2', 'done')).toEqual(['2', '5'])
      expect(yield* conversations.close('1', 'owner')).toEqual([])
      expect(flows).toEqual([
        { flow: 'close', chat: '2', via: 'system', actor: 'subagent', count: 2, status: 'ok' },
        { flow: 'close', chat: '1', via: 'app', actor: 'owner', count: 0, status: 'replayed' },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("hand the registry and the mover the Clock's time in seconds", () => {
    const { layer, calls } = services([])
    return Effect.gen(function* () {
      yield* TestClock.adjust('90 seconds')
      const conversations = yield* Conversations
      yield* conversations.markRead('2')
      yield* conversations.registerRoutine('77', 'run-1', 'Daily', 3)
      expect(yield* conversations.view('5')).toEqual(Option.none())
      expect([yield* conversations.announce('2'), yield* conversations.announce('3')]).toEqual([true, false])
      const receipt = yield* (yield* Moves).move('1', { entry: 4, operationId: 'move-1' })
      expect(receipt).toMatchObject({ state: 'refused', reason: 'streaming' })
      expect(calls).toEqual(['read:2@90', 'routine:77:run-1@90:3', 'write:41:thread-started:2', 'move:1@90'])
    }).pipe(Effect.provide(layer))
  })
})

describe('a bounded wait for an operation (C2, C3)', () => {
  const waiting = (wait: Effect.Effect<PiOperationResult, PiFailure>) =>
    Layer.succeed(PiSessions, fake<PiSessions['Service']>({ wait: () => wait }))
  const done: PiOperationResult = { operationId: 'op', session: '41', status: 'done', text: 'hi' }

  it.effect('is still running past its time, settled with its result, and a failed wait is that failure', () =>
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(
        settledWithin('41', 'op', 200).pipe(Effect.provide(waiting(Effect.never))),
      )
      yield* TestClock.adjust('201 millis')
      expect(yield* Fiber.join(running)).toEqual(Option.none())
      expect(yield* settledWithin('41', 'op', 200).pipe(Effect.provide(waiting(Effect.succeed(done))))).toEqual(
        Option.some(done),
      )
      const failure = new PiFailure({ operation: 'wait', cause: new Error('storage') })
      const failed = yield* Effect.flip(
        settledWithin('41', 'op', 200).pipe(Effect.provide(waiting(Effect.fail(failure)))),
      )
      expect(failed).toMatchObject({ _tag: 'Internal' })
    }),
  )
})
