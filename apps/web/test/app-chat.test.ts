import { describe, expect, it } from 'vitest'
import type { Part } from '../src/lib/parts.ts'
import { latestReply, replyLine } from '../src/lib/app-chat.ts'

const text = (id: string, words: string, live = false): Part => ({ kind: 'text', id, text: words, live })
const own = (id: string): Part => ({ kind: 'user', id, text: 'hi' })

describe('the chat bar’s reply line (ADR 0053)', () => {
  it('takes the first line with words, without Markdown marks or a code fence', () => {
    expect(replyLine('\n## **Done**: booked\nmore')).toBe('Done: booked')
    expect(replyLine('```js\nconst a = 1\n```')).toBe('const a = 1')
    expect(replyLine('  \n')).toBe('')
  })

  it('is the newest finished reply after the owner’s last turn, and nothing while it streams or after the owner wrote', () => {
    expect(latestReply([own('1'), text('2', 'First'), text('3', 'Second')])).toEqual({ id: '3', line: 'Second' })
    expect(latestReply([own('1'), text('2', 'Partial', true)])).toBeUndefined()
    expect(latestReply([text('2', 'Old'), own('3')])).toBeUndefined()
  })
})
