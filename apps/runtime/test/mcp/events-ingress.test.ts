import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Forbidden, Internal, NotFound, ResidentInactive, SubscriptionRequired } from '../../src/http/errors.ts'
import { McpEvents } from '../../src/mcp/events.ts'
import { EventIngress } from '../../src/mcp/events/ingress.ts'
import type { Subscription } from '../../src/mcp/events/store.ts'

const WEBHOOK = { subscriptionId: 'remote-1', id: 'evt_1', timestamp: '0', signature: '', body: new Uint8Array() }

afterEach(() => {
  vi.restoreAllMocks()
})

/** Ingress whose authority check fails with `refusal`; nothing past that check is reached. */
const refusedBy = (refusal: unknown) =>
  // SAFETY: a refused authority check answers before the store, cipher or persistence is read.
  new EventIngress({
    store: undefined as never,
    cipher: undefined as never,
    now: () => 0,
    wake: async () => undefined,
    valid: () => true,
    authorized: () => Promise.reject(refusal),
    persist: async () => undefined,
  })

describe('the Events webhook ingress (unit)', () => {
  it("ends the subscription (410) only for the owner's own refusals", async () => {
    for (const refusal of [
      new SubscriptionRequired({ subscribe: '/subscribe' }),
      new ResidentInactive({ state: 'revoked' }),
      new Forbidden({ reason: 'event connection requires authorization' }),
    ])
      expect(await refusedBy(refusal).receive(WEBHOOK)).toEqual({ status: 410 })
  })

  it('answers any other failure of the check 503, so the sender retries, and reports it', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line))
    expect(await refusedBy(new Internal({ reason: 'plan lookup failed' })).receive(WEBHOOK)).toEqual({ status: 503 })
    expect(await refusedBy(new TypeError('network')).receive(WEBHOOK)).toEqual({ status: 503 })
    const reported = lines.map((line): unknown => JSON.parse(line))
    expect(reported).toEqual([
      expect.objectContaining({ event: 'failure', where: 'mcp.events.ingress', 'error.type': 'Internal' }),
      expect.objectContaining({ event: 'failure', where: 'mcp.events.ingress', 'error.type': 'TypeError' }),
    ])
    expect(JSON.stringify(reported)).not.toContain('plan lookup failed')
  })
})

describe('which subscriptions stay valid (unit)', () => {
  /** Events over one active subscription to `serverId`, whose server lookup is `server`. */
  const events = (server: () => { readonly endpoint: string }) => {
    const row = {
      id: 'sub-1',
      remoteId: WEBHOOK.subscriptionId,
      serverId: 'notes',
      name: 'message.received',
      argumentsJson: '{}',
      endpoint: 'https://notes.test/mcp',
      status: 'active',
    }
    // SAFETY: a webhook for a tombstoned or invalid subscription reads only the rows, the grant and the server lookup.
    return new McpEvents({
      manager: { server } as never,
      store: { list: () => [row as Subscription], allows: () => true } as never,
      cipher: undefined as never,
      principal: 'owner',
      callback: 'https://goblin.test/hooks/mcp-events/owner/token',
      wake: async () => undefined,
      authorize: async () => undefined,
    })
  }

  it('drops a subscription whose server the owner removed (410)', async () => {
    const removed = events(() => {
      throw new NotFound({ what: 'server notes' })
    })
    expect(await Effect.runPromise(removed.receive(WEBHOOK))).toEqual({ status: 410 })
  })

  it('does not take any other lookup failure for a removed server', async () => {
    const broken = events(() => {
      throw new Internal({ reason: 'lookup failed' })
    })
    await expect(Effect.runPromise(broken.receive(WEBHOOK))).rejects.toMatchObject({ _tag: 'Internal' })
  })
})
