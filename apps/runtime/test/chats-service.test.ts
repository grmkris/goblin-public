import { describe, expect, it } from '@effect/vitest'
import type { PiHarness } from 'agents/harness/pi'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import { ChatDirectory } from '../src/chats/directory.ts'
import type { ChatMover } from '../src/chats/mover.ts'
import { ChatOperations, Chats, Conversations, Moves } from '../src/chats/service.ts'
import type { ConversationRegistry } from '../src/conversations.ts'
import type { FoundationServices } from '../src/layers/core.ts'
import { ConversationLive } from '../src/layers/conversation.ts'
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

/**
 * The conversation services over the one legacy instance of each: a real chat directory on SQLite, a registry and a
 * mover that record their calls, and Pi's harness for a passive write. Nothing else the layer captures is read.
 */
const services = (calls: Calls) => {
  const { db, close } = chatDatabase()
  db.insert(appConversations)
    .values([
      { chatId: '1', piSession: '41', kind: 'main', role: 'primary', createdAt: 1 },
      { chatId: '2', piSession: '42', kind: 'thread', parentSession: '1', createdAt: 1 },
    ])
    .run()
  const registry = fake<ConversationRegistry>({
    markRead: (chat, now) => void calls.push(`read:${chat}@${now}`),
    registerRoutine: (session, runId, _title, now, topic) =>
      void calls.push(`routine:${session}:${runId}@${now}:${topic}`),
    view: async () => undefined,
    announce: async (thread) => thread === '2',
  })
  const moves = fake<ChatMover>({
    move: async (chat, input, now) => {
      calls.push(`move:${chat}@${now}`)
      return { ...input, chat, mode: 'settled', state: 'refused', reason: 'streaming' }
    },
  })
  const conversation = (id: number) => ({
    submit: async (write: { readonly type: string; readonly requestId: string }) => {
      calls.push(`${write.type}:${id}:${write.requestId}`)
      return { id: 1 }
    },
  })
  // SAFETY: a passive write asks Pi's harness only for a conversation.
  const harness = fake<PiHarness>({
    pi: async () => ({ conversation: async (id: number) => conversation(id) }) as never,
  })
  const directory = new ChatDirectory(db)
  const layer = ConversationLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        // SAFETY: the adapters read only the legacy instances and the input given below; the rest stays unprovided.
        Layer.succeedContext(Context.empty() as Context.Context<FoundationServices>),
        Layer.succeed(LegacyChats, directory),
        Layer.succeed(LegacyConversations, registry),
        Layer.succeed(LegacyMoves, moves),
        Layer.succeed(AgentInput, fake<AgentInputs>({ harness })),
      ),
    ),
  )
  return {
    layer: Layer.merge(layer, Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(close)))),
    calls,
    directory,
  }
}

describe('the conversation services over the legacy instances', () => {
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

  it.effect('admit an operation once and write passively into the chat it names', () => {
    const { layer, calls } = services([])
    return Effect.gen(function* () {
      const operations = yield* ChatOperations
      yield* TestClock.adjust('20 seconds')
      expect(yield* operations.admit('2', 'op-1')).toEqual({ session: '42', existing: false })
      expect(yield* operations.admit('2', 'op-1')).toEqual({ session: '42', existing: true })
      expect(yield* operations.operation('2', 'op-1')).toEqual(Option.some('42'))
      expect(yield* operations.operation('1', 'op-1')).toEqual(Option.none())
      yield* operations.passiveWrite('2', { requestId: 'note:1', entry: { kind: 'app.note', data: {} } })
      expect(calls).toEqual(['write:42:note:1'])
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
      expect(calls).toEqual(['read:2@90', 'routine:77:run-1@90:3', 'move:1@90'])
    }).pipe(Effect.provide(layer))
  })
})
