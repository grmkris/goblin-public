import { describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach } from 'vitest'
import { type ChannelCall, type ChannelPorts, telegramChannel } from '../src/channel/channel.ts'
import { enableEvents } from '../src/channel/store.ts'
import { registerPrimary } from '../src/chats/directory.ts'
import { CredentialCipher } from '../src/mcp/cipher.ts'
import { chatDatabase } from './chats-sqlite.ts'

const KEY = 'cHVycmFibGUtdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE='

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/**
 * A channel carried by Events on SQLite, and an inbox whose first read waits for `opened`: each read answers one new
 * message from the owner and the cursor after it, then nothing.
 */
const fixture = Effect.gen(function* () {
  const { db, close } = chatDatabase()
  closes.push(close)
  registerPrimary(db, 1)
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
  const sqlite = db as never
  const cipher = yield* Effect.promise(() => CredentialCipher.fromBase64(KEY))
  const channel = yield* telegramChannel({
    db: sqlite,
    cipher,
    telemetry: undefined,
    wake: () => undefined,
  })
  enableEvents(sqlite, 'mygram', 'c0', 1)
  const opened = yield* Deferred.make<void>()
  const reads: string[] = []
  const submitted: string[] = []
  let reading = 0
  let most = 0
  const call: ChannelCall = (_name, args) =>
    Effect.gen(function* () {
      const cursor = String(args['cursor'])
      reads.push(cursor)
      reading += 1
      most = Math.max(most, reading)
      if (reads.length === 1) yield* Deferred.await(opened)
      reading -= 1
      const page = Number(cursor.slice(1))
      const messages = page < 2 ? [{ id: `m${page + 1}`, text: 'hello', direction: 'in' }] : []
      return { messages, nextCursor: `c${Math.min(page + 1, 2)}` }
    })
  const ports: ChannelPorts = {
    call,
    submit: (_text, operationId) => Effect.sync(() => void submitted.push(operationId)),
    answer: () => Effect.succeed(undefined),
  }
  return { channel, ports, opened, reads, submitted, most: () => most }
})

describe('pulling the Telegram inbox', () => {
  it.effect('takes one pull at a time: a second waits for the first, then reads from the cursor it left', () =>
    Effect.gen(function* () {
      const { channel, ports, opened, reads, submitted, most } = yield* fixture
      const first = yield* Effect.forkChild(channel.pull(ports, 1))
      const second = yield* Effect.forkChild(channel.pull(ports, 1))
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(reads).toEqual(['c0'])
      yield* Deferred.succeed(opened, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(most()).toBe(1)
      expect(reads).toEqual(['c0', 'c1', 'c2', 'c2'])
      expect(submitted).toEqual(['telegram-m1', 'telegram-m2'])
    }),
  )
})
