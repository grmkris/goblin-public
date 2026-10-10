import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import { appServices } from '../src/agent-apps/ports.ts'
import { AppCodeError } from '../src/agent-apps/queue.ts'
import { Entitlements } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { Capabilities } from '../src/capabilities/service.ts'
import type { CapabilityScope } from '../src/capabilities/profiles.ts'
import { Channel } from '../src/channel/service.ts'
import { Forbidden, ResidentInactive, SubscriptionRequired } from '../src/http/errors.ts'
import { McpConnections, Resident } from '../src/mcp/service.ts'
import type { McpCallOptions } from '../src/mcp/types.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'

const complete = () => Effect.succeed('an answer')

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 800,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** A service of which a test fakes only the members the code under test calls. */
const part = <S>(service: Partial<S>): S =>
  // SAFETY: the powers call only the members each fake gives, and every test names the calls it expects.
  service as S

/** The services an app's powers read, each the part these tests use, with what the tests change about them. */
const world = (options: { readonly resident?: boolean; readonly plan?: boolean; readonly channel?: string } = {}) => {
  const calls: { readonly serverId: string; readonly name: string; readonly authorized: boolean }[] = []
  const scope: CapabilityScope = {
    editable: true,
    server: () => true,
    tool: (_serverId, name) => name !== 'off',
    skills: () => true,
    subagents: () => true,
  }
  const refused = Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' }))
  const services = Layer.mergeAll(
    // The plan the host's re-check reads, as the fake `run` below checks it first.
    Layer.succeed(
      Entitlements,
      part<Entitlements['Service']>({ require: () => (options.plan === false ? refused : Effect.succeed(PLAN)) }),
    ),
    Layer.succeed(
      Resident,
      part<Resident['Service']>({
        require: () =>
          options.resident === false ? Effect.fail(new ResidentInactive({ state: 'revoked' })) : Effect.void,
      }),
    ),
    Layer.succeed(
      Capabilities,
      part<Capabilities['Service']>({
        app: (session: string) => Effect.succeed(session !== 'no-apps'),
        scope: () => Effect.succeed(scope),
      }),
    ),
    Layer.succeed(Budget, part<Budget['Service']>({ require: () => Effect.void })),
    Layer.succeed(
      Channel,
      part<Channel['Service']>({
        status: Effect.succeed(options.channel === undefined ? null : { serverId: options.channel, enabledAt: 1 }),
      }),
    ),
    Layer.succeed(
      McpConnections,
      part<McpConnections['Service']>({
        callTool: (serverId: string, name: string, _args: unknown, call?: McpCallOptions) =>
          Effect.gen(function* () {
            const authorized = yield* (call?.authorize ?? Effect.void).pipe(
              Effect.as(true),
              // expected: a refused re-check is what the test reads, as `authorized: false`
              Effect.orElseSucceed(() => false),
            )
            calls.push({ serverId, name, authorized })
            return { content: [], isError: name === 'refuse' }
          }),
      }),
    ),
  )
  /** The bridge's `run`: the plan check, then the program over the fakes. */
  const run: RunProgram = (program) =>
    Effect.runPromise(
      Effect.andThen(
        options.plan === false ? refused : Effect.void,
        // SAFETY: the powers' programs require only the services faked above.
        program.pipe(Effect.provide(services)) as Effect.Effect<never>,
      ),
    )
  return { powers: appServices(run, complete), calls }
}

describe("an agent app's powers over the agent's services", () => {
  it('call a tool once authority and the conversation allow it, and check again right before it leaves', async () => {
    const { powers, calls } = world()
    await powers.tool({ serverId: 'notes', name: 'write', args: {}, session: '7' })
    expect(calls).toEqual([{ serverId: 'notes', name: 'write', authorized: true }])
    await expect(powers.tool({ serverId: 'notes', name: 'off', args: {}, session: '7' })).rejects.toBeInstanceOf(
      Forbidden,
    )
    expect(calls).toHaveLength(1)
  })

  it('refuse an app a conversation switched off, and every power while authority or the plan lapsed', async () => {
    await expect(world().powers.authorizeCall('no-apps', 'tally')).rejects.toBeInstanceOf(Forbidden)
    await expect(world().powers.authorizeCall(undefined, 'tally')).resolves.toBeUndefined()
    await expect(world({ resident: false }).powers.complete('', 'hi', 10)).rejects.toBeInstanceOf(ResidentInactive)
    await expect(world({ plan: false }).powers.complete('', 'hi', 10)).rejects.toBeInstanceOf(SubscriptionRequired)
    await expect(world().powers.complete('', 'hi', 10)).resolves.toBe('an answer')
  })

  it("say why a job waits, and hand Telegram's refusals back as the app's own error", async () => {
    expect(await world({ resident: false }).powers.blocked()).toBe(
      'waiting for the owner (ResidentInactive — state: revoked)',
    )
    expect(await world().powers.blocked()).toBeUndefined()
    await expect(world().powers.notify('op-1', 'hi')).rejects.toBeInstanceOf(AppCodeError)
    const { powers, calls } = world({ channel: 'telegram' })
    await powers.notify('op-1', '<b>')
    expect(calls).toEqual([{ serverId: 'telegram', name: 'send_message', authorized: true }])
  })
})
