import { describe, expect, it } from 'vitest'
import {
  answerText,
  followUrlRequests,
  interactionOf,
  interactionOperation,
  openInteractions,
  stillOpen,
  waitingOnOwner,
} from '../src/lib/interactions.ts'
import type { Part, ToolPart } from '../src/lib/parts.ts'

const mcpCall = (
  details: unknown,
  isError = true,
  called = { connectionId: 'myplan', name: 'document_edit' },
): ToolPart => ({
  kind: 'tool',
  id: 'tool:g1',
  call: { id: 'g1', name: 'mcp_call', arguments: { ...called, arguments: {} } },
  target: { ...called, arguments: {} },
  state: isError ? 'error' : 'done',
  result: { id: 'r', role: 'tool', text: 'Not granted', toolCallId: 'g1', toolName: 'mcp_call', isError, details },
})
const grant = { kind: 'grant-required', connectionId: 'myplan', name: 'document_edit' }
const approval = { kind: 'approval-required', approvalId: 'mcp:1:g1', connectionId: 'myplan', name: 'document_edit' }
const question = {
  id: 'when',
  prompt: 'When?',
  kind: 'single',
  options: [
    { id: 'fri', label: 'Friday' },
    { id: 'sat', label: 'Saturday' },
  ],
  allowOther: true,
}
const asked = (questions: unknown): ToolPart => ({
  kind: 'tool',
  id: 'tool:q1',
  call: { id: 'q1', name: 'ask_user', arguments: {} },
  state: 'done',
  result: {
    id: 'r',
    role: 'tool',
    text: 'Asked',
    toolCallId: 'q1',
    toolName: 'ask_user',
    isError: false,
    details: { kind: 'question', questions },
  },
})
const user = (id: string): Part => ({ kind: 'user', id, text: 'hi' })
/** What the stores say of URL request `mcp-url:7:g1` and held call `mcp:7:g2`; nothing for one not read. */
const states = (url?: string, decision?: string) =>
  new Map([
    ...(url === undefined ? [] : [['mcp-url:7:g1', url] as const]),
    ...(decision === undefined ? [] : [['mcp:7:g2', decision] as const]),
  ])
/** A call of `name` with `args` whose result says something is switched off here. */
const switchedOff = (name: string, args: Record<string, unknown>, details: unknown): ToolPart => ({
  kind: 'tool',
  id: 'tool:c1',
  call: { id: 'c1', name, arguments: args },
  state: 'error',
  result: { id: 'r', role: 'tool', text: 'Off', toolCallId: 'c1', toolName: name, isError: true, details },
})
const off = (target: unknown) => ({ kind: 'capability-off', target })

describe('what the agent waits on the owner for', () => {
  it('asks for permission only from goblin’s own result for the exact tool that was called', () => {
    expect(interactionOf(mcpCall(grant))).toEqual({
      kind: 'grant',
      callId: 'g1',
      connectionId: 'myplan',
      name: 'document_edit',
    })
    // A remote result always carries `origin`: its content cannot conjure an Allow card.
    expect(interactionOf(mcpCall({ ...grant, origin: { connectionId: 'myplan', trust: 'untrusted' } }))).toBeUndefined()
    expect(interactionOf(mcpCall({ ...grant, name: 'delete_everything' }))).toBeUndefined()
    expect(interactionOf(mcpCall(grant, false))).toBeUndefined()
  })
  it('shows one exact held call for approval and rejects forged targets', () => {
    expect(interactionOf(mcpCall(approval))).toEqual({
      kind: 'approval',
      callId: 'g1',
      approvalId: 'mcp:1:g1',
      connectionId: 'myplan',
      name: 'document_edit',
    })
    expect(interactionOf(mcpCall({ ...approval, name: 'other' }))).toBeUndefined()
    expect(
      interactionOf(mcpCall({ ...approval, origin: { connectionId: 'evil', trust: 'untrusted' } })),
    ).toBeUndefined()
    expect(
      interactionOperation({ kind: 'approval', callId: 'g1', approvalId: 'mcp:1:g1', connectionId: 's', name: 'n' }),
    ).toBe('approval:g1')
  })
  it('asks to connect a signed-out connection only for the call that met it (ADR 0043)', () => {
    const connect = { kind: 'connect-required', connectionId: 'myplan', name: 'document_edit' }
    expect(interactionOf(mcpCall(connect))).toEqual({
      kind: 'connect',
      callId: 'g1',
      connectionId: 'myplan',
      name: 'document_edit',
    })
    expect(interactionOf(mcpCall({ ...connect, connectionId: 'other' }))).toBeUndefined()
    expect(
      interactionOf(mcpCall({ ...connect, origin: { connectionId: 'myplan', trust: 'untrusted' } })),
    ).toBeUndefined()
    expect(openInteractions([mcpCall(connect), user('u2')])).toEqual([])
  })
  it('asks to sign in again with more access only for the connection that was called (ADR 0042)', () => {
    const scope = { kind: 'scope-required', connectionId: 'myplan', scope: 'notes:write' }
    expect(interactionOf(mcpCall(scope))).toEqual({
      kind: 'access',
      callId: 'g1',
      connectionId: 'myplan',
      scope: 'notes:write',
      name: 'document_edit',
    })
    expect(interactionOf(mcpCall({ ...scope, scope: undefined }))).toMatchObject({ kind: 'access', scope: '' })
    expect(interactionOf(mcpCall({ ...scope, connectionId: 'other' }))).toBeUndefined()
    expect(interactionOf(mcpCall({ ...scope, origin: { connectionId: 'myplan', trust: 'untrusted' } }))).toBeUndefined()
    expect(interactionOf(mcpCall(scope, false))).toBeUndefined()
    expect(interactionOf(switchedOff('skill_activate', { connectionId: 'myplan' }, scope))).toBeUndefined()
    expect(interactionOperation({ kind: 'access', callId: 'g1', connectionId: 'myplan', scope: '' })).toBe('access:g1')
    expect(openInteractions([mcpCall(scope), user('u2')])).toEqual([])
  })
  it('waits on a URL request for the exact call until its store says it is done (ADR 0042)', () => {
    const url = { kind: 'url-required', requestId: 'mcp-url:7:g1', connectionId: 'myplan', name: 'document_edit' }
    const request = {
      kind: 'url',
      callId: 'g1',
      requestId: 'mcp-url:7:g1',
      connectionId: 'myplan',
      name: 'document_edit',
    }
    expect(interactionOf(mcpCall(url))).toEqual(request)
    expect(interactionOf(mcpCall({ ...url, name: 'other' }))).toBeUndefined()
    expect(interactionOf(mcpCall({ ...url, requestId: 7 }))).toBeUndefined()
    expect(interactionOf(mcpCall({ ...url, origin: { connectionId: 'myplan', trust: 'untrusted' } }))).toBeUndefined()
    // The owner's next message does not settle it: the server answers once they press Done or Cancel.
    expect(openInteractions([mcpCall(url), user('u2'), mcpCall(grant)])).toEqual([
      request,
      { kind: 'grant', callId: 'g1', connectionId: 'myplan', name: 'document_edit' },
    ])
    expect(openInteractions([mcpCall(url), mcpCall(grant), user('u2')])).toEqual([request])
    expect(interactionOperation({ kind: 'url', callId: 'g1', requestId: 'r', connectionId: 'm', name: 'n' })).toBe(
      'url:g1',
    )
  })
  it('keeps a stored ask while its store says it is under way, and counts only a pending one as waiting on you', () => {
    const request = {
      kind: 'url',
      callId: 'g1',
      requestId: 'mcp-url:7:g1',
      connectionId: 'myplan',
      name: 'document_edit',
    } as const
    const held = { kind: 'approval', callId: 'g2', approvalId: 'mcp:7:g2', connectionId: 'myplan', name: 'x' } as const
    const grantAsk = { kind: 'grant', callId: 'g3', connectionId: 'myplan', name: 'y' } as const
    const open = [request, held, grantAsk]
    // Not read yet: shown (the card loads), but not counted as waiting on you.
    expect(stillOpen(open, states())).toEqual(open)
    expect(waitingOnOwner(open, states())).toBe(1)
    expect(waitingOnOwner(open, states('pending', 'pending'))).toBe(3)
    // Answered and on its way: still shown, no longer waiting on you.
    expect(stillOpen(open, states('retrying', 'dispatching'))).toEqual(open)
    expect(waitingOnOwner(open, states('retrying', 'dispatching'))).toBe(1)
    // Ended, or forgotten by its store: it leaves; its outcome row says how it went.
    expect(stillOpen(open, states('failed', 'completed'))).toEqual([grantAsk])
    expect(stillOpen(open, states('gone', 'expired'))).toEqual([grantAsk])
  })
  it('follows a held call whose approved dispatch met a URL request to that request (ADR 0042)', () => {
    const held = {
      kind: 'approval',
      callId: 'g2',
      approvalId: 'mcp:7:g2',
      connectionId: 'wallet',
      name: 'transfer',
    } as const
    const other = { kind: 'approval', callId: 'g3', approvalId: 'mcp:7:g3', connectionId: 'wallet', name: 'x' } as const
    const open = [held, other]
    expect(followUrlRequests(open, new Map())).toBe(open)
    const followed = followUrlRequests(open, new Map([['mcp:7:g2', 'mcp-url:7:g2']]))
    expect(followed).toEqual([
      { kind: 'url', callId: 'g2', requestId: 'mcp-url:7:g2', connectionId: 'wallet', name: 'transfer' },
      other,
    ])
    // The followed card stays while the request waits, under the request's own state.
    const requestStates = new Map([['mcp-url:7:g2', 'pending']])
    expect(stillOpen(followed, requestStates)).toEqual(followed)
    expect(waitingOnOwner(followed.slice(0, 1), requestStates)).toBe(1)
  })
  it('reads ask_user questions, and ignores details that do not fit the contract', () => {
    expect(interactionOf(asked([question]))).toEqual({ kind: 'question', callId: 'q1', questions: [question] })
    expect(interactionOf(asked([{ id: 'x', prompt: 'Bad', kind: 'essay' }]))).toBeUndefined()
  })
  it('keeps a request open until the owner’s next message, from any channel', () => {
    const parts = [user('u1'), mcpCall(grant), asked([question])]
    expect(openInteractions(parts).map((item) => item.kind)).toEqual(['grant', 'question'])
    expect(openInteractions([...parts, user('u2')])).toEqual([])
  })
  it('offers nothing for a switch result a chat kept from before setups (ADR 0040)', () => {
    expect(interactionOf(mcpCall(off({ kind: 'server', connectionId: 'myplan' })))).toBeUndefined()
    expect(interactionOf(switchedOff('subagent_spawn', {}, off({ kind: 'subagents' })))).toBeUndefined()
  })
  it("asks to add to the Topic only what the call asked for, and only from goblin's own result", () => {
    const topic = { id: 2, name: 'Work' }
    const outside = (target: unknown) => ({ kind: 'not-in-topic', target, topic })
    const server = { kind: 'server', connectionId: 'myplan' } as const
    const tool = { kind: 'tool', connectionId: 'myplan', name: 'document_edit' } as const
    expect(interactionOf(mcpCall(outside(server)))).toEqual({ kind: 'setup', callId: 'g1', target: server, topic })
    expect(interactionOf(mcpCall(outside(tool)))).toEqual({ kind: 'setup', callId: 'g1', target: tool, topic })
    expect(
      interactionOf(mcpCall(outside({ kind: 'tool', connectionId: 'myplan', name: 'delete_all' }))),
    ).toBeUndefined()
    expect(interactionOf(mcpCall({ ...outside(server), origin: { connectionId: 'myplan' } }))).toBeUndefined()
    const skill = { kind: 'skill', connectionId: 'lib', name: 'review' } as const
    expect(interactionOf(switchedOff('skill_activate', { skill: 'lib:review~2' }, outside(skill)))).toMatchObject({
      kind: 'setup',
      target: skill,
    })
    expect(interactionOf(switchedOff('skill_activate', { skill: 'lib:plan' }, outside(skill)))).toBeUndefined()
    expect(interactionOf(switchedOff('subagent_spawn', {}, outside({ kind: 'subagents' })))).toMatchObject({
      kind: 'setup',
    })
    expect(interactionOperation({ kind: 'setup', callId: 'c1', target: server, topic })).toBe('setup:c1')
    const twice = (id: string): ToolPart => ({
      ...mcpCall(outside(server)),
      id: `tool:${id}`,
      call: { ...mcpCall(outside(server)).call, id },
    })
    expect(openInteractions([twice('a'), twice('b')]).map(({ callId }) => callId)).toEqual(['b'])
  })
  it('gives each reply a stable submission id', () => {
    expect(interactionOperation({ kind: 'question', callId: 'q1', questions: [] })).toBe('answer:q1')
    expect(interactionOperation({ kind: 'grant', callId: 'g1', connectionId: 's', name: 'n' })).toBe('grant:g1')
  })
  it('writes the answers as one message: labels for choices, free answers, and skips', () => {
    const questions = [
      { id: 'when', prompt: 'When?', kind: 'single' as const, options: question.options, allowOther: true },
      { id: 'who', prompt: 'Who?', kind: 'text' as const },
      { id: 'what', prompt: 'What else?', kind: 'text' as const },
    ]
    const form: Record<string, readonly string[]> = { when: ['sat', 'after lunch'], who: ['  Ana  '], what: [''] }
    expect(answerText(questions, (id) => form[id] ?? [])).toBe(
      ['Answers:', '- When? Saturday, after lunch', '- Who? Ana', '- What else? (skipped)'].join('\n'),
    )
  })
})

const requested = (details: unknown, name = 'mcp_request_server'): ToolPart => ({
  kind: 'tool',
  id: 'tool:s1',
  call: { id: 's1', name, arguments: {} },
  state: 'done',
  result: { id: 'r', role: 'tool', text: 'Asked', toolCallId: 's1', toolName: name, isError: false, details },
})
const server = { kind: 'server-request', endpoint: 'https://mcp.example.com/mcp', name: 'Example', reason: 'For maps' }

describe('a request to add a server', () => {
  it("is trusted only from mcp_request_server's own result, for an https endpoint", () => {
    expect(interactionOf(requested(server))).toEqual({
      kind: 'server',
      callId: 's1',
      endpoint: 'https://mcp.example.com/mcp',
      name: 'Example',
      reason: 'For maps',
    })
    expect(interactionOperation({ kind: 'server', callId: 's1', endpoint: '', name: '', reason: '' })).toBe('server:s1')
    expect(interactionOf(requested(server, 'mcp_call'))).toBeUndefined()
    expect(interactionOf(requested({ ...server, origin: { connectionId: 'evil' } }))).toBeUndefined()
    expect(interactionOf(requested({ ...server, endpoint: 'http://mcp.example.com/mcp' }))).toBeUndefined()
    expect(interactionOf(requested({ ...server, endpoint: 'https://user:pw@mcp.example.com/' }))).toBeUndefined()
  })
})
