import {
  type AppError,
  BudgetExhausted,
  Conflict,
  Forbidden,
  GrantDenied,
  Internal,
  InvalidInput,
  NeedsAuthorization,
  NotFound,
  PayloadTooLarge,
  ResidentInactive,
  SubscriptionRequired,
  Unauthenticated,
  UpstreamMcp,
  statusOf as contractStatusOf,
} from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { makeAccountHttp, ownerForward } from '../../../src/http/api/edge.ts'
import { statusOf } from '../../../src/http/respond.ts'

/** An agent stub that records what reached it. */
const recording = () => {
  const seen: Request[] = []
  return {
    seen,
    agent: {
      fetch: async (request: Request) => {
        seen.push(request)
        return Response.json({ ok: true })
      },
    },
  }
}

describe('the Worker edge of the owner API', () => {
  it('forwards only the allowlisted headers, with the edge reference, and never a credential', async () => {
    const { seen, agent } = recording()
    await ownerForward(
      new Request('https://goblin.test/api/topics/7?x=1', {
        method: 'PATCH',
        headers: {
          cookie: 'session=secret',
          authorization: 'Bearer secret',
          origin: 'https://goblin.test',
          'x-goblin-csrf': '1',
          'cf-ray': '8c1f2a3b4d5e6f70-AMS',
          'content-type': 'application/json',
          'x-goblin-request': 'r1b2c3d4',
          'x-goblin-operation': 'op-1',
        },
        body: JSON.stringify({ name: 'x' }),
      }),
      agent,
    )
    const [forwarded] = seen
    expect(forwarded?.url).toBe('https://agent/api/topics/7?x=1')
    expect(forwarded?.method).toBe('PATCH')
    expect(Object.fromEntries(forwarded?.headers ?? [])).toEqual({
      'content-type': 'application/json',
      'x-goblin-request': 'r1b2c3d4',
      'x-goblin-operation': 'op-1',
      'x-goblin-ref': '8c1f2a3b4d5e6f70-AMS',
    })
    expect(await forwarded?.json()).toEqual({ name: 'x' })
  })

  it('makes up a reference where there is no cf-ray', async () => {
    const { seen, agent } = recording()
    await ownerForward(new Request('https://goblin.test/api/topics'), agent)
    expect(seen[0]?.headers.get('x-goblin-ref')).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('refuses a JSON body over 64 KB without waking the agent, but streams a file upload through', async () => {
    const { seen, agent } = recording()
    const big = 'x'.repeat(70_000)
    const refused = await ownerForward(
      new Request('https://goblin.test/api/topics', { method: 'POST', body: big, headers: { 'cf-ray': 'ray-413' } }),
      agent,
    )
    expect(refused.status).toBe(413)
    expect(refused.headers.get('x-goblin-ref')).toBe('ray-413')
    expect(await refused.json()).toMatchObject({ error: { code: 'payload_too_large', limit: 65_536, ref: 'ray-413' } })
    expect(seen).toHaveLength(0)
    await ownerForward(new Request('https://goblin.test/api/files/uploads/a.txt', { method: 'PUT', body: big }), agent)
    expect(await seen[0]?.text()).toHaveLength(70_000)
  })

  it('answers only the account API paths', async () => {
    const handle = await Effect.runPromise(makeAccountHttp)
    expect(Option.isNone(await Effect.runPromise(handle(new Request('https://goblin.test/api/billing'))))).toBe(true)
  })
})

describe('the error statuses', () => {
  it('are the same in the contract and in the runtime routes', () => {
    const errors: readonly AppError[] = [
      new Unauthenticated({ reason: 'x' }),
      new Forbidden({ reason: 'x' }),
      new GrantDenied({ serverId: 's', name: 'n' }),
      new NotFound({ what: 'x' }),
      new Conflict({ reason: 'x' }),
      new InvalidInput({ reason: 'x' }),
      new PayloadTooLarge({ limit: 1 }),
      new ResidentInactive({ state: 'revoked' }),
      new BudgetExhausted({ limit: 1, resetsAt: 1 }),
      new SubscriptionRequired({ subscribe: '/subscribe' }),
      new NeedsAuthorization({ serverId: 's' }),
      new UpstreamMcp({ serverId: 's', reason: 'transport' }),
      new UpstreamMcp({ serverId: 's', reason: 'timeout' }),
      new Internal({ reason: 'x' }),
    ]
    for (const error of errors) expect(contractStatusOf(error)).toBe(statusOf(error))
  })
})
