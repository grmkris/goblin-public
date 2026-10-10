import type { Submission } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatOperations, type PassiveWrite } from '../src/chats/service.ts'
import { Internal } from '../src/http/errors.ts'
import { ChatMemory } from '../src/memory/chat-memory.ts'
import { Memories } from '../src/memory/service.ts'
import { forgetFrom, viewReach } from '../src/memory/store.ts'
import { appChatMemoryLog, appChatMemoryNodes, appChatMemoryState } from '../src/storage/chat-memory.ts'
import { appConversations } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'
import { knowledgeOver } from './knowledge-layer.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

/** Log rows of `chatId` for `entries`, alternating the owner's messages and the agent's. */
const log = (chatId: string, entries: readonly number[]) =>
  entries.map((entryId, idx) => ({
    chatId,
    idx,
    entryId,
    kind: idx % 2 === 0 ? ('user' as const) : ('talk' as const),
  }))
const node = (chatId: string, level: number, idx: number) => ({ chatId, level, idx, text: `${level}:${idx}`, bytes: 3 })

describe('per-Topic memory (ADR 0032)', () => {
  it("copies Main's agent-wide memory into chat 1, every idx, entry and node unchanged", () => {
    const { sqlite, migrate, db, close } = chatDatabase({ through: '20261026000000_topics' })
    cleanups.push(close)
    sqlite.exec(`INSERT INTO app_memory_log (idx, entry_id, kind) VALUES (0, 11, 'user'), (1, 12, 'talk'), (2, 15, 'echo');
      INSERT INTO app_memory_nodes (level, idx, text, bytes) VALUES (0, 0, 'user: hi', 8), (0, 1, 'talk: hello', 11),
        (1, 0, 'greeting', 8);
      INSERT INTO app_memory_state (id, origin_entry, view_through) VALUES (1, 10, 1);`)
    migrate({ after: '20261026000000_topics' })
    expect(db.select().from(appChatMemoryLog).all()).toEqual([
      { chatId: '1', idx: 0, entryId: 11, kind: 'user' },
      { chatId: '1', idx: 1, entryId: 12, kind: 'talk' },
      { chatId: '1', idx: 2, entryId: 15, kind: 'echo' },
    ])
    expect(db.select().from(appChatMemoryNodes).all()).toEqual([
      { chatId: '1', level: 0, idx: 0, text: 'user: hi', bytes: 8 },
      { chatId: '1', level: 0, idx: 1, text: 'talk: hello', bytes: 11 },
      { chatId: '1', level: 1, idx: 0, text: 'greeting', bytes: 8 },
    ])
    expect(db.select().from(appChatMemoryState).all()).toEqual([{ chatId: '1', originEntry: 10, viewThrough: 1 }])
    // The old tables stay, unread.
    expect(sqlite.prepare('SELECT count(*) AS n FROM app_memory_log').get()).toEqual({ n: 3 })
  })

  it("keeps two Topics' memories apart and truncates one without touching the other", () => {
    const { db, close } = chatDatabase()
    cleanups.push(close)
    db.insert(appChatMemoryLog)
      .values([...log('1', [11, 12, 13, 14]), ...log('70', [21, 22, 23, 24, 25])])
      .run()
    db.insert(appChatMemoryNodes)
      .values([
        node('1', 0, 0),
        node('1', 1, 1),
        node('70', 0, 1),
        node('70', 0, 2),
        node('70', 1, 0),
        node('70', 1, 1),
        node('70', 2, 0),
      ])
      .run()
    db.insert(appChatMemoryState)
      .values([
        { chatId: '1', originEntry: 10, viewThrough: 3 },
        { chatId: '70', originEntry: 20, viewThrough: 4 },
      ])
      .run()
    // SAFETY: size, sizeAt, viewThrough and truncate use SQLite only; Pi and the model are never called.
    const memory = (chat: string) =>
      new ChatMemory(chat, { db, harness: undefined as never, model: undefined as never })
    expect([memory('1').size(), memory('70').size()]).toEqual([4, 5])
    expect([memory('1').sizeAt(13), memory('70').sizeAt(23)]).toEqual([3, 3])
    expect(memory('1').sizeAt(23)).toBe(4)
    expect(memory('70').active()).toBe(true)
    expect(memory('71').active()).toBe(false)
    forgetFrom(db, '70', 2)
    expect(memory('70').size()).toBe(2)
    expect(memory('70').viewThrough()).toBe(2)
    // Node (level, idx) covers messages [idx·2^level, (idx+1)·2^level): only those wholly before 2 stay.
    expect(
      db.select({ level: appChatMemoryNodes.level, idx: appChatMemoryNodes.idx }).from(appChatMemoryNodes).all(),
    ).toEqual([
      { level: 0, idx: 0 },
      { level: 1, idx: 1 },
      { level: 0, idx: 1 },
      { level: 1, idx: 0 },
    ])
    expect([memory('1').size(), memory('1').viewThrough()]).toEqual([4, 3])
  })

  it('names what is missing when a zoom reaches a message the memory no longer holds, never its words', async () => {
    const { db, close } = chatDatabase()
    cleanups.push(close)
    db.insert(appChatMemoryLog)
      .values(log('1', [11, 12]))
      .run()
    // SAFETY: the missing row is found in SQLite before Pi or the model would be asked.
    const memory = new ChatMemory('1', { db, harness: undefined as never, model: undefined as never })
    await expect(memory.zoom(5, 1, 10)).rejects.toMatchObject({ _tag: 'MemoryMissing', what: 'message' })
    expect(await memory.zoom(5, 1, 4)).toBe('No line 5+1.')
  })

  describe('placing a view (K1)', () => {
    /**
     * Personal (`1`) with three remembered messages, each summarized, and no view yet: the next step places a view
     * through message 2, its newest input. Pi has nothing newer, and a fold threshold of 0 places it at once.
     */
    const placing = (write: (chat: string, write: PassiveWrite) => Effect.Effect<Submission, Internal>) => {
      const { db, close } = chatDatabase()
      cleanups.push(close)
      db.insert(appConversations)
        .values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 })
        .run()
      db.insert(appChatMemoryLog)
        .values(log('1', [11, 12, 13]))
        .run()
      db.insert(appChatMemoryNodes)
        .values([node('1', 0, 0), node('1', 0, 1), node('1', 0, 2)])
        .run()
      db.insert(appChatMemoryState).values({ chatId: '1', originEntry: 10, viewThrough: 0 }).run()
      const pi = { conversation: async () => ({ entries: async () => ({ items: [], next: undefined }) }) }
      // SAFETY: a step reads only `pi().conversation().entries()`, answered empty here.
      const harness = { pi: async () => pi } as never
      // Every remembered message is summarized already, so no step asks the model.
      const operations = Layer.mock(ChatOperations)({ passiveWrite: write })
      const step = Memories.use((service) => service.step('1', new AbortController().signal)).pipe(
        Effect.provide(knowledgeOver({ db, harness, foldTokens: 0, operations })),
      )
      return { db, step }
    }

    it("goes through the chat's passive write and is recorded once it is in", async () => {
      const writes: { chat: string; write: PassiveWrite }[] = []
      // SAFETY: the step only awaits the write; it never reads the submission back.
      const submitted = {} as Submission
      const { db, step } = placing((chat, write) =>
        Effect.sync(() => {
          writes.push({ chat, write })
          return submitted
        }),
      )
      expect(await Effect.runPromise(step)).toBe('done')
      expect(writes).toEqual([
        {
          chat: '1',
          write: {
            requestId: 'memory:2',
            entry: expect.objectContaining({
              kind: 'app.memory',
              head: 13,
              data: expect.objectContaining({ through: 2 }),
            }),
          },
        },
      ])
      expect(viewReach(db, '1')).toBe(2)
    })

    it('records nothing when the write fails, so the next step places the view again', async () => {
      const { db, step } = placing(() => Effect.fail(new Internal({ reason: 'unexpected' })))
      expect(await Effect.runPromise(Effect.flip(step))).toMatchObject({ _tag: 'Internal' })
      expect(viewReach(db, '1')).toBe(0)
    })
  })
})
