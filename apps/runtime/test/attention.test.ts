import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { openAsks, storedAsks } from '../src/attention.ts'
import { conversationId, entryId } from '../src/pi/context.ts'
import { appMcpApprovals } from '../src/storage/mcp-approvals.ts'
import { appAgentApps, appAgentPowers } from '../src/storage/schema.ts'
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

describe('attention (A5, ADR 0032)', () => {
  it('keeps the asks since the newest user message, from goblin markers only', () => {
    const question = result('ask_user', false, { kind: 'question', questions: [{ id: 'q', prompt: 'Which day?' }] })
    const grant = result('mcp_call', true, { kind: 'grant-required', serverId: 'notes', name: 'write' })
    const capability = result('subagent_spawn', true, {
      kind: 'not-in-topic',
      target: { kind: 'subagents' },
      topic: { id: 2, name: 'Work' },
    })
    const remote = result('mcp_call', true, { kind: 'grant-required', serverId: 'x', name: 'y', origin: 'remote' })
    const settled = result('mcp_call', true, { kind: 'grant-required', serverId: 'old', name: 'call' })
    expect(openAsks([settled, user('go on'), question, grant, capability, remote])).toEqual([
      { kind: 'question', since: question.id, entry: question.id, label: 'Which day?' },
      { kind: 'grant', since: grant.id, entry: grant.id, label: 'notes · write' },
      { kind: 'capability', since: capability.id, entry: capability.id, label: 'Add subagents to #Work' },
    ])
    expect(openAsks([user('answered')], openAsks([question]))).toEqual([])
    expect(openAsks([grant], openAsks([question])).map((ask) => ask.kind)).toEqual(['question', 'grant'])
  })

  it('lists pending held calls by session and unanswered powers of the running release by home', () => {
    const { db, close } = chatDatabase()
    cleanups.push(close)
    const held = {
      caller: 'model' as const,
      serverId: 'mail',
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
})
