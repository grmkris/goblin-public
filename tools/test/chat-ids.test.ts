import { describe, expect, it } from 'vitest'
import { chatIdViolations } from '../chat-ids.ts'

describe('logical chat boundary guard', () => {
  it('rejects imported root constants including aliases and session-less native calls', () => {
    const bad = [
      "import { ROOT_SESSION as root } from 'agents/harness/pi'",
      'pi.conversation(ROOT_CONVERSATION_ID, context)',
      'this.harness.session()',
      'class Agent { #harness; run() { this.#harness.session() } }',
      'input.harness.submit(text, { operationId })',
      'harness.submit(text)',
      'harness.submit(text, { operationId }); harness.submit(text, { session, operationId })',
      'new ChatDirectory(db)',
    ]
    for (const source of bad) expect(chatIdViolations(source), source).not.toEqual([])
  })

  it('accepts explicit sessions and ignores comments, strings and unrelated conversation APIs', () => {
    const valid = [
      'harness.session(chats.session(chat))',
      'class Agent { #harness; run() { this.#harness.submit(content, { session: admitted.session, operationId }) } }',
      'input.harness.submit(content, { session, operationId })',
      'conversation.submit({ type: "write", entry, requestId }, BACKGROUND)',
      '// ROOT_SESSION\nconst note = "harness.session() and ROOT_CONVERSATION_ID"',
    ]
    for (const source of valid) expect(chatIdViolations(source), source).toEqual([])
  })

  it('allows the composed directory without exempting composition from other chat boundaries', () => {
    expect(chatIdViolations('new ChatDirectory(db)', { directory: true })).toEqual([])
    expect(chatIdViolations('new ChatDirectory(db); harness.session()', { directory: true })).toHaveLength(1)
    expect(chatIdViolations('ROOT_CONVERSATION_ID; new ChatDirectory(db)', { root: true })).toHaveLength(1)
  })
})
