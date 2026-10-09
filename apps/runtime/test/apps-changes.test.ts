import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAppInfo } from '../src/agent-apps/engine.ts'
import { AppRegistry } from '../src/apps/registry.ts'
import { ChatDirectory, registerPrimary } from '../src/chats/directory.ts'
import { appsOver } from '../src/layers/apps.ts'
import { makeChanges } from '../src/runtime/changes.ts'
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
