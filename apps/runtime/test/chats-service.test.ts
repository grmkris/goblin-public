import { describe, expect, it } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import type { Extension } from '@earendil-works/pi-durable'
import type { PiHarness, PiOperationResult } from 'agents/harness/pi'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import { settledWithin } from '../src/chats/instance.ts'
import { moveEnd } from '../src/chats/mover.ts'
import { ChatOperations, Chats, Conversations, Moves } from '../src/chats/service.ts'
import { Conflict } from '../src/http/errors.ts'
import type { FoundationServices } from '../src/layers/core.ts'
import { ConversationLive } from '../src/layers/conversation.ts'
import { Budget } from '../src/budget.ts'
import { Models } from '../src/models.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { SingleFlight } from '../src/observability/single-flight.ts'
import { type CheapModel, CheapModels } from '../src/memory/model.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { PiFailure, PiSessions } from '../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { appChatMoves, appChatOperations, appConversations } from '../src/storage/schema.ts'
import { chatDatabase, sqliteDb } from './chats-sqlite.ts'
import { fake } from './fake.ts'

/** What Pi was asked, in order. */
type Calls = string[]

/** A page of entries as Pi's `entries` reads them: an owner's message at any one entry asked for alone, else none. */
const entriesOf = (id: number) => async (query: { readonly minEntryId?: number; readonly maxEntryId?: number }) => ({
  items:
    query.minEntryId !== undefined && query.minEntryId === query.maxEntryId
      ? [{ id: query.minEntryId, conversationId: id, kind: 'pi.user' }]
      : [],
  next: undefined,
})

/**
 * Pi's harness: a conversation's writes, aborts, configuration and forks, its entries (`entriesOf`), no run in
 * progress but an input queued in Personal, a new session, a session's model and a submit, each recorded.
 */
const harnessOf = (calls: Calls) => {
  const conversation = (id: number) => ({
    submit: async (write: { readonly type: string; readonly requestId: string }) => {
      calls.push(`${write.type}:${id}:${write.requestId}`)
      return { id: 1 }
    },
    abort: async () => void calls.push(`abort:${id}`),
    configure: async () => void calls.push(`configure:${id}`),
    entries: entriesOf(id),
    fork: async (at: number) => {
      calls.push(`fork:${id}@${at}`)
      return { id: 70 }
    },
  })
  let sessions = 60
  return fake<PiHarness>({
    // SAFETY: the services ask Pi's harness only for a conversation, a run in progress (none) and its submissions:
    // an input queued in Personal's session.
    pi: async () =>
      ({
        conversation: async (id: number) => conversation(id),
        snapshot: async () => undefined,
        inspect: async () => ({ submissions: [{ conversationId: 41, type: 'input' }] }),
      }) as never,
    // A send asks a session only to change its model.
    session: (session: string) =>
      fake<ReturnType<PiHarness['session']>>({
        setModel: async ({ id }) => void calls.push(`model:${session}:${id}`),
      }),
    // A new session is asked only for its id.
    sessions: fake<PiHarness['sessions']>({
      create: async () => fake<Awaited<ReturnType<PiHarness['sessions']['create']>>>({ id: String((sessions += 1)) }),
    }),
    submit: async (_content, options = {}) => {
      calls.push(`submit:${options.session}:${options.operationId}`)
      return { session: options.session ?? '', operationId: options.operationId ?? '', accepted: true }
    },
  })
}

/**
 * The conversation services as the agent builds them, over a real chat directory on SQLite (Personal `1`, an open
 * thread `2` owed its announcement with a thread `5` under it, and a closed thread `3`), Pi's harness above, and the
 * flows recorded. Nothing else the layer captures is read.
 */
const services = (calls: Calls) => {
  const flows: FlowEvent[] = []
  const { db, close } = chatDatabase()
  db.insert(appConversations)
    .values([
      { chatId: '1', piSession: '41', kind: 'main', role: 'primary', createdAt: 1 },
      {
        chatId: '2',
        piSession: '42',
        kind: 'thread',
        parentSession: '1',
        title: 'Plans',
        mainNote: 'owed',
        createdAt: 1,
      },
      { chatId: '5', piSession: '45', kind: 'thread', parentSession: '2', createdAt: 1 },
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
  const harness = harnessOf(calls)
  // A thread's extensions are handed to Pi's fake configure and fork, which never read them.
  const extension = fake<Extension>({})
  const input = Layer.succeed(
    AgentInput,
    fake<AgentInputs>({
      harness,
      applied: new Map(),
      subagentTools: [],
      thread: extension,
      memory: { memory: extension, recall: extension },
      moves: { handover: async () => [] },
    }),
  )
  const plans = Layer.mergeAll(
    Layer.succeed(Budget, fake<Budget['Service']>({ require: () => Effect.void })),
    Layer.succeed(Models, fake<Models['Service']>({ current: Effect.succeed('model-a') })),
    FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
  )
  const layer = ConversationLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        // SAFETY: the layer reads only the core services and the input given below; the rest stays unprovided.
        Layer.succeedContext(Context.empty() as Context.Context<FoundationServices>),
        sqliteDb(db),
        KeyedLock.layer,
        SingleFlight.layer,
        Layer.succeed(Changes, makeChanges()),
        // SAFETY: no test here names a thread, so the cheap model is never called.
        Layer.succeed(CheapModels, () => fake<CheapModel>({})),
        PiSessions.layer.pipe(Layer.provide(input)),
        input,
        plans,
      ),
    ),
  )
  return {
    layer: Layer.merge(layer, Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(close)))),
    calls,
    db,
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

  it.effect('track an operation: its receipt first, then the work, then its end, or refused if the work failed', () => {
    const { layer } = services([])
    return Effect.gen(function* () {
      const operations = yield* ChatOperations
      const start = { kind: 'start', origin: 'owner' } as const
      const made = yield* operations.tracked(
        '2',
        'op-t',
        start,
        (admitted) => Effect.succeed({ chat: '7', existing: admitted.existing }),
        ({ chat }) => ({ state: 'settled', targetChat: chat }),
      )
      expect(made).toEqual({ chat: '7', existing: false })
      expect(yield* operations.receipt('2', 'op-t')).toMatchObject(
        Option.some({ state: 'settled', targetChat: '7', session: '42' }),
      )
      const refused = yield* Effect.flip(
        operations.tracked(
          '2',
          'op-f',
          start,
          () => Effect.fail(new Conflict({ reason: 'x' })),
          () => ({
            state: 'settled',
          }),
        ),
      )
      expect(refused).toBeInstanceOf(Conflict)
      expect(yield* operations.receipt('2', 'op-f')).toMatchObject(
        Option.some({ state: 'refused', reason: 'Conflict' }),
      )
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
        answer: () => Effect.succeed(false),
      } as const
      expect(yield* operations.send(input)).toEqual({ session: '42', operationId: 'op-1', accepted: true })
      yield* operations.send(input)
      // A routine's question waiting in the chat takes `op-r` as its answer, so Pi never sees it.
      yield* operations.send({ ...input, operationId: 'op-r', answer: () => Effect.succeed(true) })
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

  it.effect("hold a chat's one admission lock in arrival order, apart from other chats", () => {
    const { layer } = services([])
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
      const second = yield* Effect.forkChild(
        operations.withChat(
          '2',
          Effect.sync(() => order.push('second')),
        ),
      )
      yield* operations.withChat(
        '1',
        Effect.sync(() => order.push('other chat')),
      )
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(order).toEqual(['first:start', 'other chat', 'first:end', 'second'])
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

  it.effect('record a Close as its close flow, one that closed nothing as a replay, and stop what it closed', () => {
    const { layer, flows, calls } = services([])
    return Effect.gen(function* () {
      const conversations = yield* Conversations
      expect(yield* conversations.close('2', 'done')).toEqual(['2', '5'])
      expect(yield* conversations.close('3', 'owner')).toEqual([])
      expect(calls).toEqual(['abort:42', 'abort:45'])
      expect(yield* Effect.flip(conversations.close('1', 'owner'))).toMatchObject({ reason: 'main_thread' })
      expect(flows.map(({ flow, chat, via, actor, count, status }) => [flow, chat, via, actor, count, status])).toEqual(
        [
          ['close', '2', 'system', 'subagent', 2, 'ok'],
          ['close', '3', 'app', 'owner', 0, 'replayed'],
          ['close', '1', 'app', 'owner', undefined, 'refused'],
        ],
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("read the Clock's time in seconds: a read mark, a routine chat, an announcement and a move", () => {
    const { layer, calls, db } = services([])
    return Effect.gen(function* () {
      yield* TestClock.adjust('90 seconds')
      const conversations = yield* Conversations
      yield* conversations.markRead('2')
      yield* conversations.registerRoutine({ session: '77', runId: 'run-1', title: 'Daily', topic: 3 })
      const row = (chat: string) => db.select().from(appConversations).where(eq(appConversations.chatId, chat)).get()
      expect(row('2')?.readAt).toBe(90)
      // Topic 3 does not exist, so the routine's chat sits under Personal's Conversation.
      expect(row('77')).toMatchObject({ createdAt: 90, parentSession: '1', topicId: 1, routineRunId: 'run-1' })
      expect(yield* conversations.view('99')).toEqual(Option.none())
      expect([yield* conversations.announce('2'), yield* conversations.announce('2')]).toEqual([true, false])
      expect(yield* conversations.announce('3')).toBe(false)
      const receipt = yield* (yield* Moves).move('1', { entry: 4, operationId: 'move-1' })
      expect(receipt).toMatchObject({ state: 'refused', reason: 'streaming' })
      expect(db.select().from(appChatMoves).all()).toMatchObject([{ operationId: 'move-1', createdAt: 90 }])
      expect(calls).toEqual(['write:41:thread-started:2'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('start a Thread once per operation, also when it is repeated at once, with its receipt and flow', () => {
    const { layer, calls, db, flows } = services([])
    return Effect.gen(function* () {
      const conversations = yield* Conversations
      const start = conversations.startThread('2', 'op-e', 'empty')
      const [first, second] = yield* Effect.all([start, start], { concurrency: 'unbounded' })
      expect([first.id, second.id]).toEqual(['61', '61'])
      expect(first).toMatchObject({ kind: 'thread', parent: '1', topic: 1, replies: 0 })
      expect(calls).toEqual(['configure:61'])
      expect(yield* conversations.startThread('2', 'op-e', 'empty')).toMatchObject({ id: '61' })
      const receipts = db.select().from(appChatOperations).all()
      expect(receipts).toEqual([
        expect.objectContaining({
          chatId: '2',
          operationId: 'op-e',
          kind: 'empty',
          state: 'settled',
          targetChat: '61',
        }),
      ])
      expect(flows.map(({ flow, chat, parentChat, status }) => [flow, chat, parentChat, status])).toEqual([
        ['empty', '61', '2', 'ok'],
        ['empty', '61', '2', 'replayed'],
        ['empty', '61', '2', 'replayed'],
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('start a Thread from the composer and reply at an entry, each with its receipt and flow', () => {
    const { layer, calls, db, flows } = services([])
    return Effect.gen(function* () {
      const conversations = yield* Conversations
      // Personal has no settled entry yet, so Start thread makes an empty Thread under it.
      expect(yield* conversations.startThread('1', 'op-s', 'latest')).toMatchObject({ id: '61', parent: '1' })
      expect(yield* conversations.startThread('2', 'op-r', { entry: 4 })).toMatchObject({
        id: '70',
        parent: '2',
        forkEntry: 4,
      })
      expect(calls).toEqual(['configure:61', 'fork:42@4'])
      expect(db.select().from(appChatOperations).all()).toEqual([
        expect.objectContaining({
          chatId: '1',
          operationId: 'op-s',
          kind: 'start',
          state: 'settled',
          targetChat: '61',
        }),
        expect.objectContaining({
          chatId: '2',
          operationId: 'op-r',
          kind: 'reply',
          state: 'settled',
          targetChat: '70',
        }),
      ])
      expect(flows.map(({ flow, chat, parentChat, status }) => [flow, chat, parentChat, status])).toEqual([
        ['start', '61', '1', 'ok'],
        ['reply', '70', '2', 'ok'],
      ])
    }).pipe(Effect.provide(layer))
  })

  it('carry a move on in its receipt as the mover answered: settled with its Thread, refused with its reason', () => {
    const move = { operationId: 'move-1', chat: '1' } as const
    expect(moveEnd({ ...move, state: 'settled', thread: '70' })).toEqual({ state: 'settled', targetChat: '70' })
    expect(moveEnd({ ...move, state: 'forked', thread: '70' })).toEqual({ state: 'submitted', targetChat: '70' })
    expect(moveEnd({ ...move, state: 'refused', reason: 'streaming' })).toEqual({
      state: 'refused',
      reason: 'streaming',
    })
  })

  it.effect('refuse a move with its reason once per operation, with its receipt and flow', () => {
    const { layer, db, flows } = services([])
    return Effect.gen(function* () {
      const moves = yield* Moves
      // An input is queued in Personal, and a thread is not a Topic's Conversation.
      expect(yield* moves.move('1', { entry: 4, operationId: 'move-1' })).toMatchObject({
        state: 'refused',
        reason: 'streaming',
      })
      expect(yield* moves.move('1', { entry: 4, operationId: 'move-1' })).toMatchObject({ state: 'refused' })
      expect(yield* moves.move('2', { entry: 4, operationId: 'move-2' })).toMatchObject({ reason: 'not_conversation' })
      expect(yield* Effect.flip(moves.move('1', { entry: 5, operationId: 'move-1' }))).toMatchObject({
        _tag: 'Conflict',
        reason: 'operation_used',
      })
      expect(yield* moves.moving('1')).toBe(false)
      expect(db.select().from(appChatOperations).all()).toEqual([
        expect.objectContaining({ chatId: '1', operationId: 'move-1', kind: 'move', state: 'refused' }),
        expect.objectContaining({ chatId: '2', operationId: 'move-2', kind: 'move', state: 'refused' }),
      ])
      expect(flows.map(({ flow, chat, status, errorType }) => [flow, chat, status, errorType])).toEqual([
        ['move', '1', 'refused', 'streaming'],
        ['move', '1', 'refused', 'streaming'],
        ['move', '2', 'refused', 'not_conversation'],
        ['move', '1', 'refused', 'Conflict'],
      ])
    }).pipe(Effect.provide(layer))
  })
})

/** Pi's sessions, whose every wait for an operation is `wait`. */
const waiting = (wait: Effect.Effect<PiOperationResult, PiFailure>) =>
  Layer.succeed(PiSessions, fake<PiSessions['Service']>({ wait: () => wait }))

describe('a bounded wait for an operation (C2, C3)', () => {
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
