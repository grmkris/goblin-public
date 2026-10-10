import { ModelChoice } from '@goblin/contracts'
import { AgentGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import type { Applied } from '../../../src/agent-model.ts'
import type { EntitlementPolicy } from '../../../src/billing/gates.ts'
import { ModelBudget, usageLedger } from '../../../src/budget.ts'
import { telegramChannel } from '../../../src/channel/channel.ts'
import { Channel } from '../../../src/channel/service.ts'
import { registerPrimary } from '../../../src/chats/directory.ts'
import { AgentHandlers } from '../../../src/routines/agent-api.ts'
import { ChatsLive } from '../../../src/layers/conversation.ts'
import { ModelBudgetLive } from '../../../src/layers/budget.ts'
import { Events, McpConnections, McpGrants, McpServers, Resident } from '../../../src/mcp/service.ts'
import { PiSessions } from '../../../src/pi/sessions.ts'
import { Db } from '../../../src/runtime/db.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import { callOwner } from '../../owner-client.ts'
import { durable } from '../../chats-sqlite.ts'
import { PLAN, currentResident, database, json, plans, serve, served, stub } from './fixture.ts'
import { unread } from '../../fake.ts'

const fixture = () => {
  const db = database()
  const sqlite = durable(db)
  registerPrimary(db, 1)
  const budget = new ModelBudget(usageLedger(sqlite), 100)
  const pinned: string[] = []
  const applied: Applied = new Map()
  const entitlements: EntitlementPolicy = { state: () => Effect.succeed(PLAN), require: () => Effect.succeed(PLAN) }
  const legacy = Layer.mergeAll(
    Layer.effect(
      Channel,
      // The channel's status and disable read and clear its tables only; the cipher stays unused.
      telegramChannel({ db: sqlite, cipher: unread, telemetry: undefined, wake: () => undefined }),
    ),
    // The channel's tools: the server offers none, so turning the channel on is refused before anything is granted.
    stub(McpServers, { tools: () => Effect.succeed([]) }),
    stub(McpConnections, { snapshot: () => Effect.succeedNone }),
    stub(McpGrants),
    stub(Events, { activeConsumer: () => Effect.succeedNone }),
    // The database the lane builds its stores over, and the gate's resident authority and plan.
    Layer.succeed(Db, sqlite),
    Layer.succeed(Resident, currentResident().service),
    plans(),
    // Choosing a model only puts the primary session on it; nothing else of Pi is reached.
    stub(PiSessions, { setModel: (session, { id }) => Effect.sync(() => void pinned.push(`${session} ${id}`)) }),
    // The agent handlers read only these from the instance input.
    Layer.succeed(
      AgentInput,
      Object.assign(Object.create(null), {
        applied,
        entitlements,
        env: { APP_URL: 'https://goblin.test', CREDENTIAL_KEY: 'unused', MODELS: 'model-b', MODEL_ID: 'model-a' },
        userId: 'owner',
        schedulePull: async () => undefined,
      }),
    ),
  )
  const { fetch } = serve(
    served([AgentGroup], AgentHandlers).pipe(
      Layer.provide(Layer.provideMerge(Layer.mergeAll(ModelBudgetLive, ChatsLive), legacy)),
    ),
  )
  return { fetch, budget, pinned, applied }
}

describe('the agent group served by the agent', () => {
  it("answers today's usage in Credits against the plan's allowance", async () => {
    const { fetch, budget } = fixture()
    budget.record({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, Math.floor(Date.now() / 1000))
    const response = await fetch(json('GET', '/api/agent/usage'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ used: 1, limit: 100 })
  })

  it('reads the model choice, moves main to a pick at once, and refuses a model not on offer', async () => {
    const { fetch, pinned, applied } = fixture()
    const choice = Schema.decodeUnknownSync(ModelChoice)(await (await fetch(json('GET', '/api/agent/model'))).json())
    expect(choice).toMatchObject({ current: 'model-a', default: 'model-a' })
    expect(choice.options.map((option) => option.id)).toEqual(['model-a', 'model-b'])
    const picked = await callOwner({ fetch }, (api) => api.agent.chooseModel({ payload: { model: 'model-b' } }))
    expect(picked.current).toBe('model-b')
    expect(pinned).toEqual([`${[...applied.keys()].join()} model-b`])
    const refused = await fetch(json('PUT', '/api/agent/model', { model: 'not-offered' }))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'model' } })
    const empty = await fetch(json('PUT', '/api/agent/model', { model: '' }))
    expect(empty.status).toBe(400)
  })

  it('answers the channel as null while off, refuses a connection without its tools, and turns it off', async () => {
    const { fetch } = fixture()
    const status = await fetch(json('GET', '/api/agent/channel'))
    expect(status.status).toBe(200)
    expect(await status.text()).toBe('null')
    const refused = await fetch(json('PUT', '/api/agent/channel', { serverId: 'myagent' }))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: { code: 'invalid_input', reason: 'myagent does not offer inbox, send_message, subscribe, unsubscribe' },
    })
    const off = await fetch(json('DELETE', '/api/agent/channel'))
    expect(off.status).toBe(200)
    expect(await off.text()).toBe('null')
    expect(await callOwner({ fetch }, (api) => api.agent.channel())).toBeNull()
  })
})
