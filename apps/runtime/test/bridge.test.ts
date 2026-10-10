import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'
import { Internal, NotFound, SubscriptionRequired } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { makeBridge } from '../src/runtime/bridge.ts'
import { plans } from './http/api/fixture.ts'

/** A bridge over a runtime with only the plan, active or not: what `run` and `local` need of the agent's services. */
const bridgeOn = (active: boolean) => {
  // SAFETY: the programs below read only Entitlements, the one service this runtime has.
  const runtime = ManagedRuntime.make(plans(active)) as ManagedRuntime.ManagedRuntime<AgentServices, never>
  return makeBridge(async () => runtime)
}

describe('the bridge', () => {
  it('rejects with the typed failure the program failed with, the same object', async () => {
    const failure = new NotFound({ what: 'chat' })
    await expect(bridgeOn(true).local(Effect.fail(failure))).rejects.toBe(failure)
  })

  it('rejects with Internal when the program dies', async () => {
    await expect(bridgeOn(true).local(Effect.die(new RangeError('boom')))).rejects.toBeInstanceOf(Internal)
  })

  it('checks the plan in run, not in local', async () => {
    const bridge = bridgeOn(false)
    await expect(bridge.run(Effect.succeed(1))).rejects.toBeInstanceOf(SubscriptionRequired)
    await expect(bridge.local(Effect.succeed(2))).resolves.toBe(2)
  })

  it('answers a runtime that failed to build as a failure, not a throw', async () => {
    const bridge = makeBridge(async () => {
      throw new RangeError('start failed')
    })
    expect(Exit.isFailure(await bridge.exit(Effect.succeed(1)))).toBe(true)
    await expect(bridge.local(Effect.succeed(1))).rejects.toBeInstanceOf(Internal)
  })
})
