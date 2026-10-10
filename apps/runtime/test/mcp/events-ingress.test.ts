import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Forbidden, Internal, NotFound, ResidentInactive, SubscriptionRequired } from '../../src/http/errors.ts'
import { makeEvents } from '../../src/mcp/events.ts'
import { receive } from '../../src/mcp/events/ingress.ts'
import type { Subscription } from '../../src/mcp/events/store.ts'
import { ReporterLive } from '../../src/observability/report.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'

const WEBHOOK = { subscriptionId: 'remote-1', id: 'evt_1', timestamp: '0', signature: '', body: new Uint8Array() }

afterEach(() => {
  vi.restoreAllMocks()
})

/** The answer of an ingress whose authority check ends with `refusal`; nothing past that check is reached. */
const refusedBy = (refusal: Effect.Effect<never, Internal | Forbidden | ResidentInactive | SubscriptionRequired>) =>
  Effect.runPromise(
    receive(
      // SAFETY: a refused authority check answers before the store, cipher or persistence is read.
      {
        store: undefined as never,
        cipher: undefined as never,
        wake: () => Effect.void,
        valid: () => Effect.succeed(true),
        authorized: refusal,
        persist: () => Effect.void,
      },
      WEBHOOK,
    ).pipe(Effect.provide(ReporterLive)),
  )

describe('the Events webhook ingress (unit)', () => {
  it("ends the subscription (410) only for the owner's own refusals", async () => {
    for (const refusal of [
      new SubscriptionRequired({ subscribe: '/subscribe' }),
      new ResidentInactive({ state: 'revoked' }),
      new Forbidden({ reason: 'event connection requires authorization' }),
    ])
      expect(await refusedBy(Effect.fail(refusal))).toEqual({ status: 410 })
  })

  it('answers any other failure of the check 503, so the sender retries, and reports it', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line))
    expect(await refusedBy(Effect.fail(new Internal({ reason: 'plan lookup failed' })))).toEqual({ status: 503 })
    expect(await refusedBy(Effect.die(new TypeError('network')))).toEqual({ status: 503 })
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
  const events = (server: Effect.Effect<{ readonly endpoint: string }, NotFound | Internal>) => {
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
    return Effect.runPromise(
      makeEvents({
        connections: { server: () => server } as never,
        store: { list: () => [row as Subscription], allows: () => true } as never,
        cipher: undefined as never,
        principal: 'owner',
        callback: 'https://goblin.test/hooks/mcp-events/owner/token',
        wake: () => Effect.void,
        authority: Effect.void,
        authorize: () => Effect.void,
      }).pipe(Effect.provide(SingleFlight.layer)),
    )
  }

  it('drops a subscription whose server the owner removed (410)', async () => {
    const removed = await events(Effect.fail(new NotFound({ what: 'server notes' })))
    expect(await Effect.runPromise(removed.receive(WEBHOOK))).toEqual({ status: 410 })
  })

  it('does not take any other lookup failure for a removed server', async () => {
    const broken = await events(Effect.fail(new Internal({ reason: 'lookup failed' })))
    await expect(Effect.runPromise(broken.receive(WEBHOOK))).rejects.toMatchObject({ _tag: 'Internal' })
  })
})
