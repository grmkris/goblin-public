import { defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { PRIMARY_CHAT } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { CapabilityProfiles } from '../../src/capabilities/profiles.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appConversations } from '../../src/storage/schema.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Probes, inAgent } from './probe.ts'

/**
 * Conversation switches on the real SQLite store: a thread copies main's, a subagent two levels down is bounded by
 * every conversation above it, one whose spawner is unknown (or an unknown session) may use nothing.
 */
async function scopeProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  db.insert(appConversations)
    .values([
      { chatId: PRIMARY_CHAT, piSession: PRIMARY_CHAT, kind: 'main', createdAt: 1 },
      { chatId: '900', piSession: '900', kind: 'thread', parentSession: PRIMARY_CHAT, createdAt: 1 },
      { chatId: '901', piSession: '901', kind: 'subagent', parentSession: '900', createdAt: 1 },
      { chatId: '902', piSession: '902', kind: 'subagent', parentSession: '901', createdAt: 1 },
      { chatId: '903', piSession: '903', kind: 'subagent', parentSession: '999', createdAt: 1 },
    ])
    .onConflictDoNothing()
    .run()
  const tool = defineTool({
    name: 'subagent',
    description: '',
    parameters: Type.Object({}),
    execute: async () => ({ content: [] }),
  })
  const retooled: string[] = []
  const profiles = new CapabilityProfiles(db, [tool], async (session) => void retooled.push(session))
  profiles.set(PRIMARY_CHAT, { kind: 'tool', serverId: 'notes', name: 'write' }, false, 1)
  profiles.copy(PRIMARY_CHAT, '900', 2)
  profiles.set('900', { kind: 'server', serverId: 'mail' }, false, 2)
  profiles.set('900', { kind: 'tool', serverId: 'mail', name: 'send' }, false, 2)
  profiles.set('901', { kind: 'skills', serverId: 'myskills' }, false, 2)
  const view = (session: string) => {
    const scope = profiles.scope(session)
    return {
      editable: scope.editable,
      mail: scope.server('mail'),
      send: scope.tool('mail', 'send'),
      read: scope.tool('notes', 'read'),
      write: scope.tool('notes', 'write'),
      skills: scope.skills('myskills'),
      subagents: scope.subagents(),
    }
  }
  // Twenty subagents deep is bounded by the thread at the top, not refused; a cycle of spawners may use nothing.
  const chain = Array.from({ length: 20 }, (_, index) => ({
    chatId: String(910 + index),
    piSession: String(910 + index),
    kind: 'subagent' as const,
    parentSession: index === 0 ? '900' : String(909 + index),
    createdAt: 1,
  }))
  // Keep each fixture insert below workerd SQLite's 100 bound-parameter limit.
  for (const row of chain) db.insert(appConversations).values(row).run()
  db.insert(appConversations)
    .values([
      { chatId: '950', piSession: '950', kind: 'subagent', parentSession: '951', createdAt: 1 },
      { chatId: '951', piSession: '951', kind: 'subagent', parentSession: '950', createdAt: 1 },
      { chatId: '960', piSession: '960', kind: 'thread', parentSession: '902', createdAt: 1 },
    ])
    .run()
  // A thread branched from a subagent copies what the subagent works under: every spawner's switches.
  profiles.copy('902', '960', 2)
  const before = {
    thread: view('900'),
    deep: view('902'),
    orphan: view('903'),
    unknown: view('12345'),
    deepest: view('929'),
    cycle: view('950'),
    fromSubagent: view('960'),
  }
  profiles.set('900', { kind: 'server', serverId: 'mail' }, true, 3)
  const serverBackOn = view('900')
  await profiles.reset('900', 4)
  const afterReset = view('900')
  const reset = [...retooled]
  // Once per marker: every conversation that filters the subagent tools (subagents off, or a broken chain) again.
  profiles.set('960', { kind: 'subagents' }, false, 5)
  await profiles.retoolOnce('retool:probe', 5)
  const once = retooled.slice(reset.length).toSorted()
  await profiles.retoolOnce('retool:probe', 6)
  const again = retooled.length - reset.length - once.length
  return { ...before, serverBackOn, afterReset, own: profiles.own('900'), retooled: reset, once, again }
}

export const probes: Probes = { scopes: inAgent(({ storage }) => scopeProbe(storage)) }

const Scope = Schema.Struct({
  editable: Schema.Boolean,
  mail: Schema.Boolean,
  send: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  skills: Schema.Boolean,
  subagents: Schema.Boolean,
})
const Scopes = Schema.Struct({
  thread: Scope,
  deep: Scope,
  orphan: Scope,
  unknown: Scope,
  deepest: Scope,
  cycle: Scope,
  fromSubagent: Scope,
  serverBackOn: Scope,
  afterReset: Scope,
  own: Schema.Array(Schema.Unknown),
  retooled: Schema.Array(Schema.String),
  once: Schema.Array(Schema.String),
  again: Schema.Number,
})
const closed = { editable: false, mail: false, send: false, read: false, write: false, skills: false, subagents: false }

/**
 * A thread copies its parent's switches, a subagent is bounded by every conversation above it, and stored tool filters
 * are applied again once (`CapabilityProfiles.retoolOnce`).
 */
async function scopeChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'scopes', Scopes)
  const thread = { editable: true, mail: false, send: false, read: true, write: false, skills: true, subagents: true }
  expect(result.thread).toEqual(thread)
  expect(result.deep).toEqual({ ...thread, editable: false, skills: false })
  expect(result.orphan).toEqual(closed)
  expect(result.unknown).toEqual(closed)
  expect(result.deepest).toEqual({ ...thread, editable: false })
  expect(result.cycle).toEqual(closed)
  expect(result.fromSubagent).toEqual({ ...thread, skills: false })
  // A server switched back on keeps the tool switched off under it.
  expect(result.serverBackOn).toEqual({ ...thread, mail: true })
  expect(result.afterReset).toEqual({ ...thread, mail: true, send: true })
  expect(result.own).toEqual([{ kind: 'tool', serverId: 'notes', name: 'write' }])
  expect(result.retooled).toEqual(['900'])
  expect(result.once).toEqual(['903', '950', '951', '960'])
  expect(result.again).toBe(0)
}

export const cases: readonly NativeCase[] = [
  {
    title: "a thread copies its parent's switches and a subagent is bounded by every conversation above it",
    run: scopeChecks,
  },
]
