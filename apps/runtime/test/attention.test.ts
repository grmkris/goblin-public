import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { heldCall, labelled, openAsks, storedAsks } from '../src/attention.ts'
import { conversationId, entryId } from '../src/pi/context.ts'
import { appMcpApprovals } from '../src/storage/mcp-approvals.ts'
import { appMcpUrlRequests } from '../src/storage/mcp-url-requests.ts'
import { appPersonaChats } from '../src/storage/personas.ts'
import { appAgentApps, appAgentPowers, appConversations, appMcpLabels } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

type Details = NonNullable<Extract<Message, { role: 'toolResult' }>['details']>
let next = 0
/** A Pi entry of the kind given holding one model message, numbered in order; its time is its number in seconds. */
const entry = (kind: string, message: (at: number) => Message): EntryRecord => {
  next += 1
  return { id: entryId(next), conversationId: conversationId('70'), kind, model: [message(next * 1000)] }
}
const user = (text: string) => entry('pi.user', (timestamp) => ({ role: 'user', content: text, timestamp }))
const result = (toolName: string, isError: boolean, details: Details) =>
  entry('pi.toolResult', (timestamp) => ({
    role: 'toolResult',
    toolName,
    toolCallId: `call-${next}`,
    content: [],
    isError,
    details,
    timestamp,
  }))

/** `record` as Persona `persona`'s answer, holding `hold` when it waits on the owner. */
const withData = (record: EntryRecord, persona: number, hold?: Record<string, string>): EntryRecord => ({
  ...record,
  data: {
    persona,
    name: `P${String(persona)}`,
    revision: 1,
    avatar: { glyph: 'P', hue: 1 },
    operationId: `op-${String(record.id)}`,
    text: 'answer',
    ...(hold === undefined ? {} : { hold }),
  },
})

describe('attention (A5, ADR 0032)', () => {
  it('keeps the asks since the newest user message, from goblin markers only', () => {
    const question = result('ask_user', false, { kind: 'question', questions: [{ id: 'q', prompt: 'Which day?' }] })
    const grant = result('mcp_call', true, { kind: 'grant-required', connectionId: 'notes', name: 'write' })
    const capability = result('subagent_spawn', true, {
      kind: 'not-in-topic',
      target: { kind: 'subagents' },
      topic: { id: 2, name: 'Work' },
    })
    const access = result('mcp_call', true, { kind: 'scope-required', connectionId: 'notes', scope: 'notes:write' })
    const connect = result('mcp_call', true, { kind: 'connect-required', connectionId: 'mercator', name: 'quote_plan' })
    const remote = result('mcp_call', true, { kind: 'grant-required', connectionId: 'x', name: 'y', origin: 'remote' })
    const settled = result('mcp_call', true, { kind: 'grant-required', connectionId: 'old', name: 'call' })
    const open = openAsks([settled, user('go on'), question, grant, capability, access, connect, remote])
    expect(labelled(open, new Map())).toEqual([
      { kind: 'question', since: question.id, entry: question.id, label: 'Which day?' },
      { kind: 'grant', since: grant.id, entry: grant.id, label: 'notes · write' },
      { kind: 'setup', since: capability.id, entry: capability.id, label: 'Add subagents to #Work' },
      { kind: 'access', since: access.id, entry: access.id, label: 'notes · more access' },
      { kind: 'connect', since: connect.id, entry: connect.id, label: 'mercator · sign in' },
    ])
    // A connection is named by the owner's label where it has one (ADR 0041).
    expect(labelled(open, new Map([['notes', 'Notes · Work']])).map((ask) => ask.label)).toEqual([
      'Which day?',
      'Notes · Work · write',
      'Add subagents to #Work',
      'Notes · Work · more access',
      'mercator · sign in',
    ])
    expect(openAsks([user('answered')], openAsks([question]))).toEqual([])
    expect(openAsks([grant], openAsks([question])).map((ask) => ask.kind)).toEqual(['question', 'grant'])
  })

  it('lists pending held calls by session and unanswered powers of the running release by home', () => {
    const { db, close } = chatDatabase()
    cleanups.push(close)
    const held = {
      caller: 'model' as const,
      connectionId: 'mail',
      name: 'send',
      endpoint: 'https://mail.example/mcp',
      grantVersion: 'v1',
      argumentsSealed: 'sealed',
      argumentsHash: 'hash',
      expiresAt: 10_000,
      createdAt: 2000,
      updatedAt: 2000,
    }
    db.insert(appMcpApprovals)
      .values([
        { ...held, id: 'a1', sessionId: '41', state: 'pending' },
        { ...held, id: 'a2', sessionId: '41', state: 'approved' },
        { ...held, id: 'a3', sessionId: '41', state: 'pending', expiresAt: 4000 },
        { ...held, id: 'a4', sessionId: '42', state: 'pending' },
      ])
      .run()
    const app = { description: '', activeRelease: 'r2', createdAt: 1000, updatedAt: 3000 }
    db.insert(appAgentApps)
      .values([
        { ...app, name: 'tracker', title: 'Tracker', homeSession: '41' },
        { ...app, name: 'other', title: 'Other', homeSession: '9' },
      ])
      .run()
    db.insert(appAgentPowers)
      .values([
        { app: 'tracker', kind: 'egress', target: 'api.example', requestedBy: 'r2' },
        { app: 'tracker', kind: 'llm', target: 'cheap', requestedBy: 'r2', approvedAt: 5 },
        { app: 'tracker', kind: 'notify', target: 'telegram', requestedBy: 'r1' },
        { app: 'other', kind: 'egress', target: 'api.example', requestedBy: 'r2' },
      ])
      .run()
    expect(storedAsks(db, { id: '1', session: '41' }, 5000)).toEqual([
      { kind: 'approval', since: 2, label: 'mail · send' },
      { kind: 'app-power', since: 3, label: 'Tracker asks for egress api.example' },
    ])
    expect(storedAsks(db, { id: '2', session: '43' }, 5000)).toEqual([])
  })

  it("holds a call from goblin's approval and grant markers only, never from a remote result", () => {
    const approval = result('mcp_call', true, {
      kind: 'approval-required',
      approvalId: 'mcp:9:c1',
      connectionId: 'sq',
      name: 'quote',
    })
    expect(heldCall(approval)).toEqual({ kind: 'approval', approvalId: 'mcp:9:c1', connectionId: 'sq', name: 'quote' })
    const grant = result('mcp_call', true, { kind: 'grant-required', connectionId: 'sq', name: 'bid' })
    expect(heldCall(grant)).toEqual({ kind: 'grant', connectionId: 'sq', name: 'bid' })
    const remote = result('mcp_call', true, { kind: 'grant-required', connectionId: 'sq', name: 'x', origin: 'sq' })
    const ran = result('mcp_call', false, { kind: 'grant-required', connectionId: 'sq', name: 'bid' })
    expect([heldCall(remote), heldCall(ran), heldCall(user('hello'))]).toEqual([undefined, undefined, undefined])
  })

  it('holds a URL request and a sign-in with more access from their markers (ADR 0042)', () => {
    const url = result('mcp_call', true, {
      kind: 'url-required',
      requestId: 'mcp-url:9:c2',
      connectionId: 'sq',
      name: 'create_agent',
    })
    expect(heldCall(url)).toEqual({ kind: 'url', requestId: 'mcp-url:9:c2', connectionId: 'sq', name: 'create_agent' })
    const access = result('mcp_call', true, {
      kind: 'scope-required',
      connectionId: 'sq',
      name: 'apply',
      scope: 'sidequest:work',
    })
    expect(heldCall(access)).toEqual({ kind: 'access', scope: 'sidequest:work', connectionId: 'sq', name: 'apply' })
    // A connection the owner has not signed in to holds the call too, so a Persona waits on the Connect card (ADR 0043).
    const connect = result('mcp_call', true, { kind: 'connect-required', connectionId: 'mercator', name: 'quote_plan' })
    expect(heldCall(connect)).toEqual({ kind: 'connect', connectionId: 'mercator', name: 'quote_plan' })
    const forged = result('mcp_call', true, { kind: 'url-required', connectionId: 'sq', name: 'x' })
    const inherited = result('mcp_call', true, { kind: 'constructor', connectionId: 'sq', name: 'x' })
    expect([heldCall(forged), heldCall(inherited)]).toEqual([undefined, undefined])
  })

  it("keeps a Persona's tool to allow until its next answer (ADR 0041)", () => {
    const answer = () => entry('app.persona', (timestamp) => ({ role: 'user', content: 'answer', timestamp }))
    const hold = { kind: 'grant', connectionId: 'sq', name: 'bid', fork: '90' }
    const asked = withData(answer(), 1, hold)
    const other = withData(answer(), 2, { ...hold, fork: '91' })
    expect(labelled(openAsks([asked, other]), new Map([['sq', 'Sidequest · Demo']]))).toEqual([
      { kind: 'grant', since: asked.id, entry: asked.id, label: 'Sidequest · Demo · bid', persona: 1 },
      { kind: 'grant', since: other.id, entry: other.id, label: 'Sidequest · Demo · bid', persona: 2 },
    ])
    expect(openAsks([withData(answer(), 1)], openAsks([asked, other])).map((ask) => ask.persona)).toEqual([2])
  })

  it("lists the pending held calls of the Persona forks answering in a chat, as that Persona's", () => {
    const { db, close } = chatDatabase()
    cleanups.push(close)
    db.insert(appConversations)
      .values([
        { chatId: '50', piSession: '50', kind: 'thread', createdAt: 1 },
        { chatId: '51', piSession: '51', kind: 'thread', role: 'persona', parentSession: '50', createdAt: 1 },
        { chatId: '52', piSession: '52', kind: 'thread', role: 'persona', parentSession: '60', createdAt: 1 },
      ])
      .run()
    db.insert(appPersonaChats)
      .values([
        { chatId: '51', personaId: 3, revision: 1, setup: '{}', createdAt: 1 },
        { chatId: '52', personaId: 4, revision: 1, setup: '{}', createdAt: 1 },
      ])
      .run()
    const held = {
      caller: 'model' as const,
      connectionId: 'sq',
      name: 'quote',
      endpoint: 'https://sq.example/mcp',
      grantVersion: 'v1',
      argumentsSealed: 'sealed',
      argumentsHash: 'hash',
      state: 'pending' as const,
      expiresAt: 10_000,
      createdAt: 2000,
      updatedAt: 2000,
    }
    db.insert(appMcpApprovals)
      .values([
        { ...held, id: 'f1', sessionId: '51' },
        { ...held, id: 'f2', sessionId: '52' },
      ])
      .run()
    expect(storedAsks(db, { id: '50', session: '50' }, 3000)).toEqual([
      { kind: 'approval', since: 2, label: 'sq · quote', persona: 3 },
    ])
  })

  it('lists the open URL requests of a chat and its Persona forks, by connection label (ADR 0042)', () => {
    const { db, close } = chatDatabase()
    cleanups.push(close)
    db.insert(appConversations)
      .values([
        { chatId: '50', piSession: '50', kind: 'thread', createdAt: 1 },
        { chatId: '51', piSession: '51', kind: 'thread', role: 'persona', parentSession: '50', createdAt: 1 },
      ])
      .run()
    db.insert(appPersonaChats).values({ chatId: '51', personaId: 3, revision: 1, setup: '{}', createdAt: 1 }).run()
    db.insert(appMcpLabels).values({ connectionId: 'sq', label: 'Sidequest · Worker' }).run()
    const request = {
      sourceCallId: 'c1',
      taskId: 't1',
      connectionId: 'sq',
      name: 'create_agent',
      endpoint: 'https://sq.example/mcp',
      argumentsSealed: 'sealed',
      argumentsHash: 'hash',
      inputKey: 'approval',
      promptSealed: 'sealed',
      state: 'pending' as const,
      expiresAt: 10_000,
      createdAt: 2000,
      updatedAt: 2000,
    }
    db.insert(appMcpUrlRequests)
      .values([
        { ...request, id: 'u1', sessionId: '50' },
        { ...request, id: 'u2', sessionId: '51' },
        { ...request, id: 'u3', sessionId: '50', state: 'completed' },
        { ...request, id: 'u4', sessionId: '50', expiresAt: 2500 },
        { ...request, id: 'u5', sessionId: '60' },
      ])
      .run()
    expect(storedAsks(db, { id: '50', session: '50' }, 3000)).toEqual([
      { kind: 'link', since: 2, label: 'Sidequest · Worker · create_agent' },
      { kind: 'link', since: 2, label: 'Sidequest · Worker · create_agent', persona: 3 },
    ])
  })
})
