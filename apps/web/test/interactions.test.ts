import { describe, expect, it } from 'vitest'
import { answerText, interactionOf, interactionOperation, openInteractions } from '../src/lib/interactions.ts'
import type { Part, ToolPart } from '../src/lib/parts.ts'

const mcpCall = (
  details: unknown,
  isError = true,
  called = { serverId: 'myplan', name: 'document_edit' },
): ToolPart => ({
  kind: 'tool',
  id: 'tool:g1',
  call: { id: 'g1', name: 'mcp_call', arguments: { ...called, arguments: {} } },
  target: { ...called, arguments: {} },
  state: isError ? 'error' : 'done',
  result: { id: 'r', role: 'tool', text: 'Not granted', toolCallId: 'g1', toolName: 'mcp_call', isError, details },
})
const grant = { kind: 'grant-required', serverId: 'myplan', name: 'document_edit' }
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

describe('what the agent waits on the owner for', () => {
  it('asks for permission only from Purrable’s own result for the exact tool that was called', () => {
    expect(interactionOf(mcpCall(grant))).toEqual({
      kind: 'grant',
      callId: 'g1',
      serverId: 'myplan',
      name: 'document_edit',
    })
    // A remote result always carries `origin`: its content cannot conjure an Allow card.
    expect(interactionOf(mcpCall({ ...grant, origin: { serverId: 'myplan', trust: 'untrusted' } }))).toBeUndefined()
    expect(interactionOf(mcpCall({ ...grant, name: 'delete_everything' }))).toBeUndefined()
    expect(interactionOf(mcpCall(grant, false))).toBeUndefined()
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
  it('gives each reply a stable submission id', () => {
    expect(interactionOperation({ kind: 'question', callId: 'q1', questions: [] })).toBe('answer:q1')
    expect(interactionOperation({ kind: 'grant', callId: 'g1', serverId: 's', name: 'n' })).toBe('grant:g1')
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
