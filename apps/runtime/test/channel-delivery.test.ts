import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { afterEach } from 'vitest'
import { type ChannelCall, type ChannelPorts, type DeliveredReply, telegramChannel } from '../src/channel/channel.ts'
import { enableEvents, trackReply } from '../src/channel/store.ts'
import { registerPrimary } from '../src/chats/directory.ts'
import { UpstreamMcp } from '../src/http/errors.ts'
import { CredentialCipher } from '../src/mcp/cipher.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const KEY = 'cHVycmFibGUtdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE='

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** A channel carried by Events on SQLite with one answer to send, and the tools of a channel server that `sends`. */
const fixture = (sends: ChannelCall) =>
  Effect.gen(function* () {
    const { db, close } = chatDatabase()
    closes.push(close)
    registerPrimary(db, 1)
    const cipher = yield* Effect.promise(() => CredentialCipher.fromBase64(KEY))
    const sqlite = durable(db)
    const channel = yield* telegramChannel({
      db: sqlite,
      cipher,
      telemetry: undefined,
      wake: () => undefined,
    })
    enableEvents(sqlite, 'mygram', '', 1)
    trackReply(sqlite, 'telegram-m1', 1)
    const ports: ChannelPorts = {
      call: sends,
      submit: () => Effect.void,
      answer: () => Effect.succeed('The plants are watered.'),
    }
    const delivered: DeliveredReply[] = []
    const deliver = channel.deliver(ports, 2, (reply) => Effect.sync(() => void delivered.push(reply)))
    return { deliver, delivered }
  })

describe('delivering answers to Telegram', () => {
  it.effect("hears each answer's delivery once it is stored", () =>
    Effect.gen(function* () {
      const { deliver, delivered } = yield* fixture(() => Effect.succeed({ id: 'remote-1' }))
      expect(yield* deliver).toBe(false)
      expect(delivered).toEqual([{ operationId: 'telegram-m1', pieces: 1 }])
      yield* deliver
      expect(delivered).toHaveLength(1)
    }),
  )

  it.effect('hears a failed delivery with its error type, then fails as before', () =>
    Effect.gen(function* () {
      const { deliver, delivered } = yield* fixture(() =>
        Effect.fail(new UpstreamMcp({ connectionId: 'mygram', reason: 'transport' })),
      )
      expect(yield* Effect.flip(deliver)).toMatchObject({ _tag: 'UpstreamMcp' })
      expect(delivered).toEqual([{ operationId: 'telegram-m1', pieces: 1, errorType: 'UpstreamMcp:transport' }])
    }),
  )
})
