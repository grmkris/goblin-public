import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { InvalidInput, UpstreamMcp } from '../src/http/errors.ts'
import { Events, McpConnections } from '../src/mcp/service.ts'
import type { McpConnectionSnapshot } from '../src/mcp/types.ts'
import { setSkillEvents } from '../src/skills/events.ts'
import { Skills } from '../src/skills/service.ts'
import { fake } from './fake.ts'

/**
 * Turning a server's skills on, over fakes: `offered` are the event names its Events listing has, `refused` the reason
 * its Events answer this connection with instead; what was granted, subscribed and switched is recorded.
 */
const world = (offered: readonly string[], refused?: UpstreamMcp['reason']) => {
  const seen: { grants: string[]; subscribed: string[]; enabled: string[] } = {
    grants: [],
    subscribed: [],
    enabled: [],
  }
  const snapshot = fake<McpConnectionSnapshot>({ capabilities: { events: {} } })
  const layer = Layer.mergeAll(
    Layer.succeed(McpConnections, fake<McpConnections['Service']>({ connect: () => Effect.succeed(snapshot) })),
    Layer.succeed(
      Events,
      fake<Events['Service']>({
        activeConsumer: () => Effect.succeed(Option.none()),
        grant: (_server, name, _args, allowed) =>
          Effect.sync(() => void seen.grants.push(`${name}:${String(allowed)}`)),
        subscribe: (input) =>
          refused !== undefined
            ? Effect.fail(new UpstreamMcp({ connectionId: input.connectionId, reason: refused, code: -32003 }))
            : offered.includes(input.name)
              ? Effect.sync(() => {
                  seen.subscribed.push(input.name)
                  return { subscriptionId: `s-${input.name}`, status: 'active' }
                })
              : Effect.fail(new InvalidInput({ reason: 'event not available with poll and webhook' })),
      }),
    ),
    Layer.succeed(
      Skills,
      fake<Skills['Service']>({
        setEnabled: (connectionId, enabled) =>
          Effect.sync(() => void seen.enabled.push(`${connectionId}:${String(enabled)}`)),
      }),
    ),
  )
  return {
    seen,
    run: <A, E>(program: Effect.Effect<A, E, Events | McpConnections | Skills>) =>
      Effect.runPromise(Effect.provide(program, layer)),
  }
}

describe("turning a server's skills on (ADR 0008)", () => {
  it('subscribes to the skills events a server offers', async () => {
    const { seen, run } = world(['skills.updated', 'skills.list_changed'])
    expect(await run(setSkillEvents('lib', true))).toEqual({ connectionId: 'lib', enabled: true })
    expect(seen.subscribed).toEqual(['skills.updated', 'skills.list_changed'])
    expect(seen.enabled).toEqual(['lib:true'])
  })

  it('still turns them on for a server whose Events are its own, and takes back the grants it could not use', async () => {
    const { seen, run } = world(['sidequest.jobs'])
    expect(await run(setSkillEvents('sidequest', true))).toEqual({ connectionId: 'sidequest', enabled: true })
    expect(seen.subscribed).toEqual([])
    expect(seen.grants).toEqual([
      'skills.updated:true',
      'skills.updated:false',
      'skills.list_changed:true',
      'skills.list_changed:false',
    ])
    expect(seen.enabled).toEqual(['sidequest:true'])
  })

  it('still turns them on when the server refuses its Events to this connection', async () => {
    const { seen, run } = world([], 'remote-rpc')
    expect(await run(setSkillEvents('sidequest', true))).toEqual({ connectionId: 'sidequest', enabled: true })
    expect(seen.grants).toEqual([
      'skills.updated:true',
      'skills.updated:false',
      'skills.list_changed:true',
      'skills.list_changed:false',
    ])
    expect(seen.enabled).toEqual(['sidequest:true'])
  })

  it('fails the switch, and leaves skills off, when the connection itself fails', async () => {
    const { seen, run } = world([], 'transport')
    await expect(run(setSkillEvents('sidequest', true))).rejects.toThrow()
    expect(seen.enabled).toEqual([])
  })
})
