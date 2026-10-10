import { InvalidInput } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { connectCallback } from '../../src/mcp/program.ts'
import { McpServers, Resident } from '../../src/mcp/service.ts'
import { plans, stub } from '../http/api/fixture.ts'

/** The callback over a plan, resident authority that counts renewals, and a host whose `finishConnect` is `finish`. */
const callback = async (
  query: string,
  finish: (state: string) => Effect.Effect<string, InvalidInput> = () => Effect.succeed('notes'),
  active = true,
) => {
  const renewals: number[] = []
  const finished: string[] = []
  const services = Layer.mergeAll(
    plans(active),
    stub(Resident, { renew: () => Effect.sync(() => void renewals.push(1)) }),
    stub(McpServers, {
      finishConnect: (state: string) => Effect.tap(finish(state), () => Effect.sync(() => void finished.push(state))),
    }),
  )
  const target = await Effect.runPromise(
    connectCallback(new URLSearchParams(query), 'https://goblin.test').pipe(Effect.provide(services)),
  )
  return { target: target.href, renewals: renewals.length, finished }
}

describe('the outbound sign-in callback', () => {
  it('lands on Connections with the connected server after the owner admission', async () => {
    const result = await callback('state=s1&code=c1&iss=https://auth.test')
    expect(result).toEqual({ target: 'https://goblin.test/connections?connected=notes', renewals: 1, finished: ['s1'] })
  })

  it("answers the authorization server's error, or an incomplete callback, without finishing anything", async () => {
    expect((await callback('error=access_denied&state=s1')).target).toBe(
      'https://goblin.test/connections?error=access_denied',
    )
    const incomplete = await callback('state=s1')
    expect(incomplete).toEqual({
      target: 'https://goblin.test/connections?error=authorization_failed',
      renewals: 0,
      finished: [],
    })
  })

  it('names the failure that stopped it: a refused finish, the plan, or a defect', async () => {
    const refused = await callback('state=s1&code=c1', () => Effect.fail(new InvalidInput({ reason: 'state' })))
    expect(refused.target).toBe('https://goblin.test/connections?error=InvalidInput')
    const unpaid = await callback('state=s1&code=c1', undefined, false)
    expect(unpaid).toEqual({
      target: 'https://goblin.test/connections?error=SubscriptionRequired',
      renewals: 0,
      finished: [],
    })
    const broken = await callback('state=s1&code=c1', () => Effect.die(new Error('broken')))
    expect(broken.target).toBe('https://goblin.test/connections?error=Internal')
  })
})
