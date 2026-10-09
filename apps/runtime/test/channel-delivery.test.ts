import { afterEach, describe, expect, it } from 'vitest'
import { type ChannelPorts, type DeliveredReply, TelegramChannel } from '../src/channel/channel.ts'
import { ChatDirectory, registerPrimary } from '../src/chats/directory.ts'
import { UpstreamMcp } from '../src/http/errors.ts'
import { CredentialCipher } from '../src/mcp/cipher.ts'
import { chatDatabase } from './chats-sqlite.ts'

const KEY = 'cHVycmFibGUtdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE='

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** A channel carried by Events on SQLite with one answer to send, and the tools of a channel server that `sends`. */
const fixture = async (sends: (name: string) => Promise<unknown>) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  registerPrimary(db, 1)
  const cipher = await CredentialCipher.fromBase64(KEY)
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
  const channel = new TelegramChannel(db as never, cipher, () => undefined, undefined, new ChatDirectory(db))
  channel.enableEvents('mygram', '', 1)
  channel.track('telegram-m1', 1)
  const ports: ChannelPorts = {
    call: sends,
    submit: async () => undefined,
    answer: async () => 'The plants are watered.',
  }
  const delivered: DeliveredReply[] = []
  const deliver = () =>
    channel.deliver(ports, 2, async (reply) => {
      delivered.push(reply)
    })
  return { deliver, delivered }
}

describe('delivering answers to Telegram', () => {
  it("hears each answer's delivery once it is stored", async () => {
    const { deliver, delivered } = await fixture(async () => ({ id: 'remote-1' }))
    expect(await deliver()).toBe(false)
    expect(delivered).toEqual([{ operationId: 'telegram-m1', pieces: 1 }])
    await deliver()
    expect(delivered).toHaveLength(1)
  })

  it('hears a failed delivery with its error type, then fails as before', async () => {
    const { deliver, delivered } = await fixture(async () => {
      throw new UpstreamMcp({ serverId: 'mygram', reason: 'transport' })
    })
    await expect(deliver()).rejects.toMatchObject({ _tag: 'UpstreamMcp' })
    expect(delivered).toEqual([{ operationId: 'telegram-m1', pieces: 1, errorType: 'UpstreamMcp:transport' }])
  })
})
