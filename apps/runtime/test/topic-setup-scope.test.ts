import { EVERYTHING, type TopicSetup } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openAsks } from '../src/attention.ts'
import { chatScope, piToolsFor, routinesOutside, sessionScope } from '../src/setup/scope.ts'
import { outsideScopeResult } from '../src/pi/setup.ts'
import { appPersonaChats } from '../src/storage/personas.ts'
import { appRoutineRuns, appRoutines } from '../src/storage/routines.ts'
import { RoutineStore } from '../src/routines/store.ts'
import { appHelperExclusions, appConversations, appExecutionExclusions } from '../src/storage/schema.ts'
import { appTopics } from '../src/storage/topics.ts'
import { storedSetup } from '../src/topics/setup.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const WORK: TopicSetup = {
  mcpServers: [
    { connectionId: 'notes', tools: ['read'] },
    { connectionId: 'plan', tools: 'all' },
  ],
  skills: [{ connectionId: 'lib', name: 'review' }],
  apps: ['tracker'],
  subagents: false,
}

const DEFINITION = JSON.stringify({
  title: 'Daily',
  trigger: { kind: 'cron', expression: '0 9 * * *' },
  timezone: 'UTC',
  tellMe: { on: false, telegram: false },
  handTo: {
    kind: 'goblin',
    instruction: 'Report.',
    allowedTools: [
      { connectionId: 'notes', name: 'read' },
      { connectionId: 'notes', name: 'write' },
      { connectionId: 'mail', name: 'send' },
    ],
    budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
  },
})

/**
 * Personal (everything) with Main, and Topic 2 "Work" with `WORK`: its Conversation `20`, a thread `21`, a subagent
 * `22` started from the thread, a routine thread `23` and a Persona's hidden fork `24`. Every chat's Pi session is its
 * chat id with an `s` in front.
 */
const fixture = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  const chat = (chatId: string, values: Partial<typeof appConversations.$inferInsert> = {}) =>
    db
      .insert(appConversations)
      .values({ chatId, piSession: `s${chatId}`, kind: 'thread', createdAt: 1, ...values })
      .run()
  chat('1', { kind: 'main', role: 'primary' })
  db.insert(appTopics)
    .values({
      id: 2,
      name: 'Work',
      chatId: '20',
      setup: storedSetup(WORK),
      createdBy: 'owner',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  chat('20', { kind: 'main', role: 'conversation', topicId: 2 })
  chat('21', { parentSession: '20', topicId: 2 })
  chat('22', { kind: 'subagent', parentSession: '21', topicId: 2 })
  db.insert(appRoutineRuns)
    .values({
      id: 'rr_1',
      routineId: 'r_1',
      revision: 1,
      operationId: 'op',
      source: 'cron',
      firedAt: 1,
      definitionJson: DEFINITION,
      admittedAt: 1,
      deadlineAt: 2,
      state: 'running',
      reportRequestId: 'report',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  chat('23', { parentSession: '20', topicId: 2, routineRunId: 'rr_1' })
  return { db: durable(db), raw: db }
}

describe("a chat's scope follows its Topic's setup (ADR 0040)", () => {
  it('lets every chat of Personal use everything, as before', () => {
    const { db } = fixture()
    const scope = sessionScope(db, 's1')
    expect(scope.tool('anything', 'at-all')).toBe(true)
    expect(scope.skills('lib')).toBe(true)
    expect(scope.subagents()).toBe(true)
    expect(scope.app('diary')).toBe(true)
    expect(scope.topic).toMatchObject({ id: 1, name: 'Personal' })
  })

  it("holds a Topic's Conversation and its threads to what the setup lists", () => {
    const { db } = fixture()
    for (const chat of ['20', '21']) {
      const scope = chatScope(db, chat)
      expect(scope.editable).toBe(true)
      expect(scope.server('notes')).toBe(true)
      expect(scope.tool('notes', 'read')).toBe(true)
      expect(scope.tool('notes', 'write')).toBe(false)
      expect(scope.tool('plan', 'anything')).toBe(true)
      expect(scope.server('mail')).toBe(false)
      expect(scope.skills('lib')).toBe(true)
      expect(scope.skill('lib', 'review', 'skill://v2/review/SKILL.md')).toBe(true)
      expect(scope.skill('lib', 'plan')).toBe(false)
      expect(scope.skills('other')).toBe(false)
      expect(scope.subagents()).toBe(false)
      expect(scope.app('tracker')).toBe(true)
      expect(scope.app('diary')).toBe(false)
    }
  })

  it('reads the setup live: a change reaches every chat of the Topic at its next check', () => {
    const { db, raw } = fixture()
    expect(chatScope(db, '21').server('mail')).toBe(false)
    raw
      .update(appTopics)
      .set({ setup: storedSetup({ ...WORK, mcpServers: 'all' }) })
      .where(eq(appTopics.id, 2))
      .run()
    expect(chatScope(db, '21').tool('mail', 'send')).toBe(true)
    expect(chatScope(db, '22').tool('mail', 'send')).toBe(true)
  })

  it("bounds a subagent by its Topic and by its spawner's exclusions, and never lets the owner act there", () => {
    const { db, raw } = fixture()
    raw
      .insert(appHelperExclusions)
      .values({ sessionId: '22', kind: 'server', connectionId: 'plan', name: '', offAt: 1 })
      .run()
    raw.insert(appExecutionExclusions).values({ sessionId: '22', app: 'tracker', offAt: 1 }).run()
    const scope = chatScope(db, '22')
    expect(scope.editable).toBe(false)
    expect(scope.tool('notes', 'read')).toBe(true)
    expect(scope.server('plan')).toBe(false)
    expect(scope.server('mail')).toBe(false)
    expect(scope.app('tracker')).toBe(false)
  })

  it("gives a routine's thread only its allowed tools that its Topic holds, and no skills, subagents or apps", () => {
    const { db } = fixture()
    const scope = chatScope(db, '23')
    expect(scope.tool('notes', 'read')).toBe(true)
    expect(scope.tool('notes', 'write')).toBe(false)
    expect(scope.tool('mail', 'send')).toBe(false)
    expect(scope.skills('lib')).toBe(false)
    expect(scope.app('tracker')).toBe(false)
    expect(scope.topic?.holds({ kind: 'tool', connectionId: 'mail', name: 'send' })).toBe(false)
  })

  it("joins the Persona's setup for a routine run handed to it, still within the routine's allowed tools", () => {
    const { db, raw } = fixture()
    raw
      .insert(appPersonaChats)
      .values({
        chatId: '23',
        personaId: 1,
        revision: 2,
        setup: JSON.stringify({ mcpServers: [{ connectionId: 'mail', tools: 'all' }], skills: [], apps: ['diary'] }),
        createdAt: 1,
      })
      .run()
    const scope = chatScope(db, '23')
    expect(scope.tool('mail', 'send')).toBe(true)
    expect(scope.tool('mail', 'delete')).toBe(false)
    expect(scope.tool('notes', 'read')).toBe(true)
    expect(scope.tool('notes', 'write')).toBe(false)
    expect(scope.app('diary')).toBe(false)
    expect(scope.editable).toBe(false)
  })

  it('lets nothing through for a chat without a Topic or a session no chat owns', () => {
    const { db, raw } = fixture()
    raw.delete(appTopics).where(eq(appTopics.id, 2)).run()
    expect(chatScope(db, '21').tool('notes', 'read')).toBe(false)
    expect(sessionScope(db, 'nobody').server('notes')).toBe(false)
  })

  it("removes the subagent tools from Pi where the Topic's setup does not allow subagents", () => {
    const { db } = fixture()
    // SAFETY: the filter only passes the registrations through; no member of one is read.
    const tools = [{ name: 'subagent_spawn' }] as never
    expect(piToolsFor(db, tools, '1')).toBeNull()
    expect(piToolsFor(db, tools, '21')).toEqual({ remove: tools })
  })
})

describe("a Persona's fork works with its Topic's setup and its own (ADR 0040)", () => {
  /** Two Persona forks of the thread `21`: `24` adds the mail server and an app, `25` was asked before setups. */
  const forks = () => {
    const { db, raw } = fixture()
    for (const chatId of ['24', '25'])
      raw
        .insert(appConversations)
        .values({
          chatId,
          piSession: `s${chatId}`,
          kind: 'thread',
          role: 'persona',
          parentSession: '21',
          topicId: 2,
          createdAt: 1,
        })
        .run()
    raw
      .insert(appPersonaChats)
      .values({
        chatId: '24',
        personaId: 1,
        revision: 3,
        setup: JSON.stringify({ mcpServers: [{ connectionId: 'mail', tools: 'all' }], skills: [], apps: ['diary'] }),
        createdAt: 1,
      })
      .run()
    return db
  }

  it('lets the Persona use what it adds, while Goblin in the same Topic still may not', () => {
    const db = forks()
    const persona = chatScope(db, '24')
    expect(persona.tool('mail', 'send')).toBe(true)
    expect(persona.tool('notes', 'read')).toBe(true)
    expect(persona.tool('notes', 'write')).toBe(false)
    expect(persona.app('diary')).toBe(true)
    expect(persona.subagents()).toBe(false)
    expect(persona.editable).toBe(false)
    expect(chatScope(db, '21').tool('mail', 'send')).toBe(false)
  })

  it("keeps each Persona's fork to its own setup: one asked before setups adds nothing", () => {
    const db = forks()
    const older = chatScope(db, '25')
    expect(older.tool('mail', 'send')).toBe(false)
    expect(older.tool('notes', 'read')).toBe(true)
    expect(older.subagents()).toBe(false)
  })

  it('tells a Persona in words what neither setup holds', () => {
    const db = forks()
    const result = outsideScopeResult({ kind: 'server', connectionId: 'calendar' }, chatScope(db, '24'))
    expect(result.details).toBeUndefined()
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('calendar') })])
  })
})

describe('a call outside the setup', () => {
  it('asks the owner to add it to the Topic, and waits', () => {
    const { db } = fixture()
    const result = outsideScopeResult({ kind: 'server', connectionId: 'mail' }, chatScope(db, '21'))
    expect(result.details).toEqual({
      kind: 'not-in-topic',
      target: { kind: 'server', connectionId: 'mail' },
      topic: { id: 2, name: 'Work' },
    })
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('wait for their reply') })])
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'not_in_topic' })])
  })

  it('names a skills library as a library, and gives a subagent words only', () => {
    const { db } = fixture()
    const library = outsideScopeResult({ kind: 'skills', connectionId: 'other' }, chatScope(db, '22'))
    expect(library.details).toBeUndefined()
    expect(library.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Not in #Work's setup: skills from other") }),
    ])
  })

  it("tells a subagent in words what its spawner switched off, though the Topic's setup holds it", () => {
    const { db, raw } = fixture()
    raw
      .insert(appHelperExclusions)
      .values({ sessionId: '22', kind: 'tool', connectionId: 'notes', name: 'read', offAt: 1 })
      .run()
    const result = outsideScopeResult({ kind: 'tool', connectionId: 'notes', name: 'read' }, chatScope(db, '22'))
    expect(result.details).toBeUndefined()
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('Off for the conversation') }),
    ])
  })

  it('shows the owner what to add, and where, among what waits on them', () => {
    const { db } = fixture()
    const result = outsideScopeResult({ kind: 'tool', connectionId: 'notes', name: 'write' }, chatScope(db, '21'))
    const entry = {
      id: '5',
      kind: 'pi.tool_result',
      model: [{ role: 'toolResult', toolName: 'mcp_call', isError: true, timestamp: 9000, ...result }],
    }
    // SAFETY: `openAsks` reads only an entry's id, kind and model messages, which this entry has.
    expect(openAsks([entry as never])).toEqual([
      { kind: 'setup', since: 9, entry: 5, label: 'Add notes · write to #Work' },
    ])
  })
})

describe('the routines a setup leaves out', () => {
  it('names each live routine of the Topic with the allowed tools the setup does not hold', () => {
    const { db, raw } = fixture()
    const routine = (id: string, state: 'active' | 'archived', topicId: number) =>
      raw
        .insert(appRoutines)
        .values({
          id,
          revision: 1,
          state,
          definitionJson: DEFINITION,
          proposerUserId: 'u',
          createdAt: 1,
          updatedAt: 1,
          topicId,
        })
        .run()
    routine('r_live', 'active', 2)
    routine('r_done', 'archived', 2)
    routine('r_elsewhere', 'active', 1)
    expect(routinesOutside(db, 2, WORK)).toEqual([
      {
        id: 'r_live',
        title: 'Daily',
        outside: [
          { connectionId: 'notes', name: 'write' },
          { connectionId: 'mail', name: 'send' },
        ],
      },
    ])
    expect(routinesOutside(db, 2, EVERYTHING)).toEqual([])
  })

  it("flags them on the routine's own view, with its Topic", () => {
    const { db, raw } = fixture()
    raw
      .insert(appRoutines)
      .values({
        id: 'r_1',
        revision: 1,
        state: 'proposed',
        definitionJson: DEFINITION,
        proposerUserId: 'owner',
        createdAt: 1,
        updatedAt: 1,
        topicId: 2,
      })
      .run()
    expect(new RoutineStore(db, 'owner').view('r_1')).toMatchObject({
      topic: 2,
      outsideSetup: [
        { connectionId: 'notes', name: 'write' },
        { connectionId: 'mail', name: 'send' },
      ],
    })
  })
})

describe('a setup of everything', () => {
  it('is what Personal holds after the migration', () => {
    const { raw } = fixture()
    const row = raw.select({ setup: appTopics.setup }).from(appTopics).where(eq(appTopics.id, 1)).get()
    expect(JSON.parse(row?.setup ?? '')).toEqual(EVERYTHING)
  })
})
