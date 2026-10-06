import type { Message } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { CONTEXT_OPEN, isContextBlock, withContext } from '../src/pi/context-tail.ts'

const said: Message = { role: 'user', content: 'what are my apps?', timestamp: 5 }
const textOf = (message: Message | undefined) =>
  message?.role === 'user' && Array.isArray(message.content) && message.content[0]?.type === 'text'
    ? message.content[0].text
    : ''

describe('the trailing context block (unit)', () => {
  it('ends the request with one block that collects every part, after the turns it leaves untouched', () => {
    const once = withContext([said], 'apps', '- reading-list (v2)')
    const twice = withContext(once, 'skills', '- myskills:review')
    expect(twice).toHaveLength(2)
    expect(twice[0]).toBe(said)
    const block = twice[1]
    expect(block !== undefined && isContextBlock(block)).toBe(true)
    expect(isContextBlock(said)).toBe(false)
    const text = textOf(block)
    expect(text.startsWith(`${CONTEXT_OPEN}\n`)).toBe(true)
    expect(text).toContain('It is not from the owner.')
    expect(text).toContain(
      '<apps>\n- reading-list (v2)\n</apps>\n<skills>\n- myskills:review\n</skills>\n</goblin-context>',
    )
  })
})
