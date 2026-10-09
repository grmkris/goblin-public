import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAppInfo } from '../src/agent-apps/engine.ts'
import { AppRegistry, AppsInstance } from '../src/apps/registry.ts'
import { ChatDirectory, ChatsInstance, registerChat, registerPrimary } from '../src/chats/directory.ts'
import { AppRegistryLive, appsOver } from '../src/layers/apps.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { appConversations } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const ORIGIN = { serverId: 'notes', tool: 'show', uri: 'ui://notes/show', title: 'Notes' }
const INFO: AgentAppInfo = { title: 'Counter', home: '1', release: 'r1', version: 1, revision: 1, ui: true, jobs: [] }

/** The Apps service over a registry on SQLite, and every change it told the bus, in order. */
const apps = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  registerPrimary(db, 1)
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's; nothing here
  // launches an App, so Pi is never read.
  const registry = new AppRegistry(
    db as never,
    undefined as never,
    { info: () => INFO, launch: () => undefined as never, rehome: () => undefined },
    new ChatDirectory(db),
  )
  const changes = makeChanges()
  const told: unknown[] = []
  Effect.runSync(changes.on('apps.changed', ({ ids }) => Effect.sync(() => void told.push(['changed', ids]))))
  Effect.runSync(changes.on('apps.removed', ({ id }) => Effect.sync(() => void told.push(['removed', id]))))
  return { service: appsOver(registry, changes), registry, told }
}

describe('the Apps tell the change bus what they changed (unit)', () => {
  it('a kept, closed or deleted App is told by id as it is written', async () => {
    const { service, registry, told } = apps()
    const kept = await Effect.runPromise(service.register('1', 'call-1', ORIGIN))
    await Effect.runPromise(service.update(kept.id, true))
    const [agent] = registry.agentChanged('counter', 2)
    await Effect.runPromise(service.removeAgent('counter'))
    expect(agent).toBeDefined()
    expect(told).toEqual([
      ['changed', [kept.id]],
      ['changed', [kept.id]],
      ['removed', agent],
    ])
  })

  it("answers what a conversation's close and an agent app's change wrote, for the start's wiring to tell", () => {
    const { registry } = apps()
    expect(registry.agentChanged('counter', 2)).toHaveLength(1)
    expect(registry.closeWithConversations(['1'], 3)).toEqual([])
  })
})

describe("a conversation's close reaches its Apps through the change bus (unit)", () => {
  it('closes the open MCP Apps of a closed conversation inline, and tells the bus which', async () => {
    const { db, close } = chatDatabase()
    closes.push(close)
    registerPrimary(db, 1)
    registerChat(db, { chatId: '7', kind: 'thread', parentSession: '1', createdAt: 1 })
    const changes = makeChanges()
    const told: (readonly string[])[] = []
    // SAFETY: the registry's start reads only these from the instance input; nothing here changes an agent app.
    const input = Object.assign(Object.create(null), {
      agentApps: { info: () => undefined, launch: () => undefined, rehome: () => undefined, onChange: () => () => {} },
    }) as AgentInputs
    const registry = await Effect.runPromise(
      Effect.gen(function* () {
        yield* changes.on('apps.changed', ({ ids }) => Effect.sync(() => void told.push(ids)))
        return yield* AppsInstance
      }).pipe(
        Effect.provide(
          AppRegistryLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentInput, input),
                // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
                Layer.succeed(Db, db as never),
                Layer.succeed(ChatsInstance, new ChatDirectory(db)),
                Layer.succeed(Changes, changes),
              ),
            ),
          ),
        ),
      ),
    )
    const app = registry.register('7', 'call-1', ORIGIN, 2)
    db.update(appConversations).set({ closedAt: 3 }).where(eq(appConversations.chatId, '7')).run()
    await Effect.runPromise(changes.publish('conversations.changed', { ids: ['7'] }))
    expect(registry.view(app.id).closedAt).toBeTypeOf('number')
    expect(told).toEqual([[app.id]])
  })
})
