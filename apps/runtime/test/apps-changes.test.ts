import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAppInfo } from '../src/agent-apps/engine.ts'
import { type AgentAppsPort, agentAppChanged, appView, closeWithConversations, keepApp } from '../src/apps/registry.ts'
import { Apps } from '../src/apps/service.ts'
import { registerChat, registerPrimary } from '../src/chats/directory.ts'
import { AppRegistryLive, appsOver } from '../src/layers/apps.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { appConversations } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'
import { stub } from './http/api/fixture.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const ORIGIN = { serverId: 'notes', tool: 'show', uri: 'ui://notes/show', title: 'Notes' }
const INFO: AgentAppInfo = { title: 'Counter', home: '1', release: 'r1', version: 1, revision: 1, ui: true, jobs: [] }

/** The Apps service over the registry's rows on SQLite, and every change it told the bus, in order. */
const apps = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  registerPrimary(db, 1)
  // SAFETY: nothing here launches an App, so `launch` is never called.
  const sources: AgentAppsPort = { info: () => INFO, launch: () => undefined as never, rehome: () => undefined }
  const changes = makeChanges()
  const told: unknown[] = []
  Effect.runSync(changes.on('apps.changed', ({ ids }) => Effect.sync(() => void told.push(['changed', ids]))))
  Effect.runSync(changes.on('apps.removed', ({ id }) => Effect.sync(() => void told.push(['removed', id]))))
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's; nothing here
  // launches an App, so Pi is never read.
  const service = appsOver(db as never, sources, changes, undefined as never)
  return { service, db, sources, told }
}

describe('the Apps tell the change bus what they changed (unit)', () => {
  it('a kept, closed or deleted App is told by id as it is written', async () => {
    const { service, db, sources, told } = apps()
    const kept = await Effect.runPromise(service.register('1', 'call-1', ORIGIN))
    await Effect.runPromise(service.update(kept.id, true))
    const [agent] = agentAppChanged(db, sources, 'counter', 2)
    await Effect.runPromise(service.removeAgent('counter'))
    expect(agent).toBeDefined()
    expect(told).toEqual([
      ['changed', [kept.id]],
      ['changed', [kept.id]],
      ['removed', agent],
    ])
  })

  it("answers what a conversation's close and an agent app's change wrote, for the start's wiring to tell", () => {
    const { db, sources } = apps()
    expect(agentAppChanged(db, sources, 'counter', 2)).toHaveLength(1)
    expect(closeWithConversations(db, sources, ['1'], 3)).toEqual([])
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
      agentApps: { info: () => undefined, launch: () => undefined, rehome: () => undefined },
    }) as AgentInputs
    // SAFETY: nothing here launches an App, so `launch` is never called.
    const agents = { info: () => undefined, launch: () => undefined as never, rehome: () => undefined }
    const app = keepApp(db, agents, { session: '7', callId: 'call-1', origin: ORIGIN }, 2)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* changes.on('apps.changed', ({ ids }) => Effect.sync(() => void told.push(ids)))
        yield* Apps
        db.update(appConversations).set({ closedAt: 3 }).where(eq(appConversations.chatId, '7')).run()
        yield* changes.publish('conversations.changed', { ids: ['7'] })
      }).pipe(
        Effect.provide(
          AppRegistryLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentInput, input),
                // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
                Layer.succeed(Db, db as never),
                Layer.succeed(Changes, changes),
                stub(PiSessions),
              ),
            ),
          ),
        ),
      ),
    )
    expect(appView(db, agents, app.id).closedAt).toBeTypeOf('number')
    expect(told).toEqual([[app.id]])
  })
})
