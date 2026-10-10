import { defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { PRIMARY_CHAT } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { CapabilityProfiles } from '../../src/capabilities/profiles.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appConversationCapabilities, appConversations } from '../../src/storage/schema.ts'
import { appTopics } from '../../src/storage/topics.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Probes, inAgent } from './probe.ts'

/** Work's setup: the notes server's `read` only, the whole `myskills` library, every app, subagents. */
const WORK = {
  mcpServers: [{ serverId: 'notes', tools: ['read'] }],
  skills: [{ serverId: 'myskills' }],
  apps: 'all',
  subagents: true,
} as const

/**
 * Topic setups on the real SQLite store (ADR 0040): Personal holds everything; a thread of "Work" holds Work's setup,
 * read live; a subagent two levels down is bounded by it and by its spawner's exclusions; one whose spawner is
 * unknown (or an unknown session, or a cycle) may use nothing. Then the owner's old switches are dropped once.
 */
async function scopeProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  db.insert(appTopics)
    .values({
      id: 2,
      name: 'Work',
      chatId: '800',
      setup: JSON.stringify(WORK),
      createdBy: 'owner',
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing()
    .run()
  const work = { topicId: 2, createdAt: 1 }
  db.insert(appConversations)
    .values([
      { chatId: PRIMARY_CHAT, piSession: PRIMARY_CHAT, kind: 'main', createdAt: 1 },
      { chatId: '800', piSession: '800', kind: 'main', role: 'conversation', ...work },
      { chatId: '900', piSession: '900', kind: 'thread', parentSession: '800', ...work },
      { chatId: '901', piSession: '901', kind: 'subagent', parentSession: '900', ...work },
      { chatId: '902', piSession: '902', kind: 'subagent', parentSession: '901', ...work },
      { chatId: '903', piSession: '903', kind: 'subagent', parentSession: '999', ...work },
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
  await profiles.configureHelper('900', '901', [{ kind: 'skills', serverId: 'myskills' }], 2)
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
    ...work,
  }))
  // Keep each fixture insert below workerd SQLite's 100 bound-parameter limit.
  for (const row of chain) db.insert(appConversations).values(row).run()
  db.insert(appConversations)
    .values([
      { chatId: '950', piSession: '950', kind: 'subagent', parentSession: '951', ...work },
      { chatId: '951', piSession: '951', kind: 'subagent', parentSession: '950', ...work },
      { chatId: '960', piSession: '960', kind: 'thread', parentSession: '902', ...work },
    ])
    .run()
  const before = {
    main: view(PRIMARY_CHAT),
    thread: view('900'),
    deep: view('902'),
    orphan: view('903'),
    unknown: view('12345'),
    deepest: view('929'),
    cycle: view('950'),
    fromSubagent: view('960'),
  }
  // The setup is read live: Work takes every server, then stops allowing subagents.
  const setup = (next: object) =>
    db
      .update(appTopics)
      .set({ setup: JSON.stringify(next) })
      .where(eq(appTopics.id, 2))
      .run()
  setup({ ...WORK, mcpServers: 'all' })
  const allServers = view('900')
  setup({ ...WORK, subagents: false })
  // Once per marker: every owner chat whose filter removes the subagent tools now, Persona forks and routines aside.
  const configured = [...retooled]
  await profiles.retoolOnce('retool:probe', 5)
  const once = retooled.slice(configured.length).toSorted()
  await profiles.retoolOnce('retool:probe', 6)
  const again = retooled.length - configured.length - once.length
  // An owner switch left from before setups goes; the helper's exclusions stay.
  db.insert(appConversationCapabilities)
    .values({ sessionId: '900', kind: 'subagents', serverId: '', name: '', offAt: 1 })
    .run()
  const dropped = await profiles.dropSwitchesOnce('drop:probe', 7)
  const droppedAgain = await profiles.dropSwitchesOnce('drop:probe', 8)
  const helperKept = view('902').skills
  return { ...before, allServers, configured, once, again, dropped, droppedAgain: droppedAgain ?? null, helperKept }
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
  main: Scope,
  thread: Scope,
  deep: Scope,
  orphan: Scope,
  unknown: Scope,
  deepest: Scope,
  cycle: Scope,
  fromSubagent: Scope,
  allServers: Scope,
  configured: Schema.Array(Schema.String),
  once: Schema.Array(Schema.String),
  again: Schema.Number,
  dropped: Schema.Struct({ switches: Schema.Number, apps: Schema.Number }),
  droppedAgain: Schema.Null,
  helperKept: Schema.Boolean,
})
const closed = { editable: false, mail: false, send: false, read: false, write: false, skills: false, subagents: false }

/**
 * Every chat works with its Topic's setup, read live; a subagent is bounded by every chat above it and its spawner's
 * exclusions; stored tool filters are applied again once (`CapabilityProfiles.retoolOnce`), and the owner's old
 * switches are dropped once (`dropSwitchesOnce`).
 */
async function scopeChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'scopes', Scopes)
  const thread = { editable: true, mail: false, send: false, read: true, write: false, skills: true, subagents: true }
  expect(result.main).toEqual({ ...thread, mail: true, send: true, write: true })
  expect(result.thread).toEqual(thread)
  expect(result.deep).toEqual({ ...thread, editable: false, skills: false })
  expect(result.orphan).toEqual(closed)
  expect(result.unknown).toEqual(closed)
  expect(result.deepest).toEqual({ ...thread, editable: false })
  expect(result.cycle).toEqual(closed)
  expect(result.fromSubagent).toEqual(thread)
  expect(result.allServers).toEqual({ ...thread, mail: true, send: true, write: true })
  expect(result.configured).toEqual(['901'])
  expect(result.once).toContain('900')
  expect(result.once).not.toContain(PRIMARY_CHAT)
  expect(result.again).toBe(0)
  expect(result.dropped).toEqual({ switches: 1, apps: 0 })
  expect(result.droppedAgain).toBeNull()
  expect(result.helperKept).toBe(false)
}

export const cases: readonly NativeCase[] = [
  {
    title: "every chat works with its Topic's setup and a subagent is bounded by every chat above it",
    run: scopeChecks,
  },
]
