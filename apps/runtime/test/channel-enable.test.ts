import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { afterEach } from 'vitest'
import { type ChannelCall, telegramChannel } from '../src/channel/channel.ts'
import { ChatDirectory, registerPrimary } from '../src/chats/directory.ts'
import { UpstreamMcp } from '../src/http/errors.ts'
import { CredentialCipher } from '../src/mcp/cipher.ts'
import { chatDatabase } from './chats-sqlite.ts'

const KEY = 'cHVycmFibGUtdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE='

/** A channel server that cannot be reached. */
const unreachable: ChannelCall = () => Effect.fail(new UpstreamMcp({ serverId: 'mygram', reason: 'transport' }))

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** A real channel on SQLite, and the channel server's tools answering from `pages` (one inbox page per call). */
const fixture = (pages: number, subscribe: unknown = { status: 'subscribed' }) =>
  Effect.gen(function* () {
    const { db, close } = chatDatabase()
    closes.push(close)
    registerPrimary(db, 1)
    const cipher = yield* Effect.promise(() => CredentialCipher.fromBase64(KEY))
    const channel = yield* telegramChannel({
      // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
      db: db as never,
      cipher,
      chats: new ChatDirectory(db),
      telemetry: undefined,
      wake: () => undefined,
    })
    const calls: string[] = []
    const call: ChannelCall = (name, args) =>
      Effect.sync(() => {
        const cursor = args['cursor']
        calls.push(`${name}:${typeof cursor === 'string' ? cursor : ''}`)
        if (name === 'subscribe') return subscribe
        const page = calls.filter((each) => each.startsWith('inbox')).length
        const messages = page <= pages ? [{ id: `m${page}`, text: 'old', direction: 'in' }] : []
        return { messages, nextCursor: `c${page}` }
      })
    return { channel, call, calls }
  })

describe('turning the Telegram channel on', () => {
  it.effect('reads an inbox to its end, so its history is not taken for new messages, and keeps the doorbell', () =>
    Effect.gen(function* () {
      const { channel, call, calls } = yield* fixture(2)
      const status = yield* channel.enable('mygram', 'https://goblin.test/hooks/x', call, 100)
      expect(status).toEqual({ serverId: 'mygram', enabledAt: 100, transport: 'doorbell' })
      expect(calls).toEqual(['inbox:', 'inbox:c1', 'inbox:c2', 'subscribe:'])
      expect(yield* channel.secret).toMatch(/^[A-Za-z0-9+/]{43}=$/u)
      expect(yield* channel.startCursor('mygram', call)).toBe('c3')
      expect(calls).toHaveLength(4)
    }),
  )

  it.effect('refuses a doorbell myagent did not subscribe, and stores nothing', () =>
    Effect.gen(function* () {
      const { channel, call } = yield* fixture(0, { status: 'refused', reason: 'bot' })
      const refused = yield* Effect.flip(channel.enable('mygram', 'https://goblin.test/hooks/x', call, 100))
      expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'the doorbell was refused: bot' })
      expect(yield* channel.status).toBeNull()
    }),
  )

  it.effect("fails with the channel server's own failure, unchanged", () =>
    Effect.gen(function* () {
      const { channel } = yield* fixture(0)
      const failed = yield* Effect.flip(channel.startCursor('mygram', unreachable))
      expect(failed).toMatchObject({ _tag: 'UpstreamMcp', reason: 'transport' })
    }),
  )
})
