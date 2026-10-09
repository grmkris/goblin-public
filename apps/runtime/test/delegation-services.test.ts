import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentApps } from '../src/agent-apps/engine.ts'
import { Home, HomeService } from '../src/home/service.ts'
import { DelegationLive } from '../src/layers/delegation.ts'
import { OrganizeReceipts } from '../src/organize/receipts.ts'
import { Receipts } from '../src/organize/service.ts'
import { PersonaInvocations } from '../src/personas/invocations.ts'
import { PersonaRegistry } from '../src/personas/registry.ts'
import { Invocations, Personas } from '../src/personas/service.ts'
import * as Legacy from '../src/services.ts'
import { appConversations } from '../src/storage/schema.ts'
import { TopicRegistry } from '../src/topics/registry.ts'
import { Topics } from '../src/topics/service.ts'
import { chatDatabase } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** Lane D's services over the legacy instances, each on real SQLite, as the agent's layers build them. */
const services = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  db.insert(appConversations).values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 }).run()
  const topics = new TopicRegistry(db, {
    open: async () => '100',
    register: () => undefined,
    activate: async () => undefined,
    seed: async () => undefined,
    retitle: () => undefined,
  })
  const personas = new PersonaRegistry(db, ['model-a'])
  // SAFETY: with no agent apps, Home reads only the engine's (empty) app list.
  const engine = Object.assign(Object.create(null) as AgentApps, { store: { apps: () => [] } })
  // SAFETY: nothing here places an App, so the App registry and the feed are never read.
  const unread = Object.create(null) as never
  const home = new HomeService(db, unread, engine)
  return Layer.provide(
    DelegationLive,
    Layer.mergeAll(
      Layer.succeed(Legacy.Topics, topics),
      Layer.succeed(Legacy.Personas, personas),
      Layer.succeed(Legacy.Invocations, new PersonaInvocations(db)),
      Layer.succeed(Legacy.Receipts, new OrganizeReceipts(db, () => undefined)),
      Layer.succeed(Legacy.Home, home),
      Layer.succeed(Legacy.Workspace, unread),
    ),
  )
}

const scout = {
  name: 'Scout',
  avatar: { glyph: 'S', hue: 120 },
  role: 'Finds things out',
  instructions: 'Be brief.',
  exclusions: [],
}

describe("lane D's services over the legacy instances", () => {
  it('answers what the registries hold, and their refusals as typed failures', async () => {
    const program = Effect.gen(function* () {
      const topics = yield* Topics
      const personas = yield* Personas
      const invocations = yield* Invocations
      const receipts = yield* Receipts
      const home = yield* Home
      return {
        topics: (yield* topics.list).map((topic) => topic.name),
        missingTopic: yield* Effect.flip(topics.get(99)),
        made: yield* personas.create({ ...scout, operationId: 'op-1' }, 'owner', 10),
        named: yield* personas.byName('scout'),
        stale: yield* Effect.flip(personas.update(1, { role: 'x', expectedRevision: 9 }, 'owner', 11)),
        offers: yield* personas.offers('model-b'),
        invocation: yield* invocations.get('op-1', 1),
        receipts: yield* receipts.list(),
        missingReceipt: yield* Effect.flip(receipts.get('org_none')),
        home: yield* home.read,
      }
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(services())))
    expect(result.topics).toEqual(['Personal'])
    expect(result.missingTopic).toMatchObject({ _tag: 'NotFound', what: 'topic' })
    expect(result.made).toMatchObject({ created: true, persona: { id: 1, revision: 1 } })
    expect(Option.getOrUndefined(result.named)).toMatchObject({ id: 1, name: 'Scout' })
    expect(result.stale).toMatchObject({ _tag: 'Conflict', reason: 'revision' })
    expect(result.offers).toBe(false)
    expect(Option.isNone(result.invocation)).toBe(true)
    expect(result.receipts).toEqual([])
    expect(result.missingReceipt).toMatchObject({ _tag: 'NotFound', what: 'receipt' })
    expect(result.home).toEqual({ layout: { revision: 0, tiles: [] }, apps: [] })
  })
})
