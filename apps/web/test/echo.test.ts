import { describe, expect, it } from 'vitest'
import { delivered, newestEntry, startsTurn } from '../src/lib/echo.ts'
import { projectSnapshot } from '../src/lib/projection.ts'

const snapshot = (entries: readonly unknown[], extra: Record<string, unknown> = {}) =>
  projectSnapshot({ type: 'snapshot', entries, tools: [], inbox: [], ...extra })
const said = (id: number, content: string) => ({ id, model: [{ role: 'user', content }] })

describe('the echo of a sent message', () => {
  it('reads the newest entry, which a message sent now comes after', () => {
    expect(newestEntry(snapshot([]))).toBe(0)
    expect(newestEntry(snapshot([said(3, 'a'), said(9, 'b'), said(5, 'c')]))).toBe(9)
  })
  it('starts a turn only when nothing runs and nothing waits; otherwise the send queues', () => {
    expect(startsTurn(snapshot([]))).toBe(true)
    expect(startsTurn(snapshot([], { run: {} }))).toBe(false)
    expect(startsTurn(snapshot([], { inbox: [{ id: 4, mode: 'followUp' }] }))).toBe(false)
  })
  it('is delivered by the owner’s first message after the entry it was sent behind, whatever its words', () => {
    const echo = { id: 'echo:op', text: 'hello', after: 2 }
    const none = snapshot([said(1, 'old'), said(2, 'older')]).messages
    expect(delivered(echo, none)).toBeUndefined()
    const landed = snapshot([said(1, 'old'), said(2, 'older'), said(3, 'hello there')]).messages
    expect(delivered(echo, landed)).toMatchObject({ id: '3:0' })
  })
  it('is not delivered by a message another author wrote', () => {
    const echo = { id: 'echo:op', text: 'hello', after: 0 }
    const note = { id: 1, model: [{ role: 'user', content: 'note', author: 'mcp' }] }
    const messages = snapshot([note]).messages
    // Whether a message carries an author is the projection's reading; an authored one is not the owner's.
    expect(messages.some((message) => message.role === 'user' && message.author !== undefined)).toBe(
      delivered(echo, messages) === undefined,
    )
  })
})
