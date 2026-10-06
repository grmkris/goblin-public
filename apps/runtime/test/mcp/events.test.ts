import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as Schema from 'effect/Schema'
import { McpConnectionManager, offersEvents } from '../../src/mcp/connection.ts'
import { EventsListResult } from '../../src/mcp/events/protocol.ts'
import { decodeEnvelope, sign, verifyWebhook } from '../../src/mcp/events/webhook.ts'
import { eventsHookToken, eventsHookTokenValid } from '../../src/mcp/events/route-token.ts'
import { EventsFixture } from './events-fixture.ts'

const SECRET = `whsec_${Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')}`
const BODY = new TextEncoder().encode(
  '{ "eventId": "evt_vector", "name": "message.received", "timestamp": "2026-10-05T12:00:00Z", "data": {"inboxCursor":"1"} }',
)
const TIMESTAMP = '1791201600'
const HEADERS = {
  id: 'evt_vector',
  timestamp: TIMESTAMP,
  signature: `v1,${createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64'))
    .update(`evt_vector.${TIMESTAMP}.`)
    .update(BODY)
    .digest('base64')}`,
}

describe('Events Standard Webhooks profile (unit)', () => {
  it('matches an independent HMAC implementation over exact bytes and accepts dual signatures', async () => {
    expect(await sign(SECRET, HEADERS.id, TIMESTAMP, BODY)).toBe(HEADERS.signature)
    await expect(verifyWebhook(SECRET, HEADERS, BODY, Number(TIMESTAMP) * 1000)).resolves.toBeUndefined()
    await expect(
      verifyWebhook(
        SECRET,
        { ...HEADERS, signature: `v1,invalid ${HEADERS.signature}` },
        BODY,
        Number(TIMESTAMP) * 1000,
      ),
    ).resolves.toBeUndefined()
    await expect(
      verifyWebhook(
        SECRET,
        HEADERS,
        new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(BODY)))),
        Number(TIMESTAMP) * 1000,
      ),
    ).rejects.toThrow()
    await expect(verifyWebhook(SECRET, HEADERS, BODY, (Number(TIMESTAMP) + 301) * 1000)).rejects.toThrow()
  })
  it('separates control schemas, rejects occurrence id mismatch and malformed controls', () => {
    expect(
      decodeEnvelope(new TextEncoder().encode('{"type":"verification","challenge":"nonce"}'), 'msg_verification_1'),
    ).toEqual({ type: 'verification', challenge: 'nonce' })
    expect(() => decodeEnvelope(BODY, 'another_id')).toThrow()
    expect(() =>
      decodeEnvelope(new TextEncoder().encode('{"type":"unknown","eventId":"evt_vector"}'), 'evt_vector'),
    ).toThrow()
  })
  it('uses a user-bound, purpose-separated route token', async () => {
    const key = btoa('goblin-test-key-32-bytes-long!!!')
    const token = await eventsHookToken(key, 'owner')
    expect(await eventsHookTokenValid(key, 'owner', token)).toBe(true)
    expect(await eventsHookTokenValid(key, 'other', token)).toBe(false)
  })
})

describe('actual MCP Events connection manager (unit)', () => {
  it('preserves top-level capabilities.events and checks exact grants before opening a connection', async () => {
    const fixture = new EventsFixture()
    let allowed = false
    let calls = 0
    const manager = new McpConnectionManager({
      servers: [{ serverId: 'fixture', endpoint: 'https://events.test/mcp' }],
      allows: () => false,
      auth: () => ({ token: async () => 'fixture-bearer' }),
      fetch: (input, init) => {
        calls++
        return fixture.fetch(input, init)
      },
      authorizeEvents: () => {
        if (!allowed) throw new Error('ungranted')
      },
    })
    try {
      await expect(
        manager.eventRequest(
          'fixture',
          { name: 'message.received', argumentsJson: '{}' },
          'events/list',
          {},
          EventsListResult,
        ),
      ).rejects.toThrow()
      expect(calls).toBe(0)
      allowed = true
      const snapshot = await manager.connect('fixture')
      expect(offersEvents(snapshot)).toBe(true)
      expect(snapshot.capabilities.events).toEqual({})
      const catalog = await manager.eventRequest(
        'fixture',
        { name: 'message.received', argumentsJson: '{}' },
        'events/list',
        {},
        EventsListResult,
      )
      expect(catalog.events.map((e) => e.name)).toContain('question.answered')
      expect(Schema.is(EventsListResult)(catalog)).toBe(true)
    } finally {
      await manager.closeAll()
    }
  })
})
