import { describe, expect, it } from 'vitest'
import { DraftThread } from '../src/lib/draft-thread.ts'

const ids = () => {
  let next = 0
  return () => `message-${(next += 1)}`
}

describe('a draft thread on its first send', () => {
  it('is made once under the draft operation, however many sends wait for it', async () => {
    const draft = new DraftThread('op-draft', ids())
    const made: string[] = []
    let finish: ((thread: string) => void) | undefined
    const make = (operationId: string) => {
      made.push(operationId)
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    }
    const first = draft.thread(make)
    const second = draft.thread(make)
    finish?.('12')
    await expect(Promise.all([first, second])).resolves.toEqual(['12', '12'])
    await expect(draft.thread(make)).resolves.toBe('12')
    expect(made).toEqual(['op-draft'])
  })

  it('asks again under the same operation after a make that failed', async () => {
    const draft = new DraftThread('op-draft', ids())
    const made: string[] = []
    await expect(
      draft.thread(async (operationId) => {
        made.push(operationId)
        return undefined
      }),
    ).resolves.toBeUndefined()
    await expect(
      draft.thread(async (operationId) => {
        made.push(operationId)
        return '13'
      }),
    ).resolves.toBe('13')
    expect(made).toEqual(['op-draft', 'op-draft'])
  })

  it('keeps the first message on one operation while it is retried unchanged', () => {
    const draft = new DraftThread('op-draft', ids())
    const first = draft.message({ input: 'Hello' })
    expect(draft.message({ input: 'Hello' })).toBe(first)
    expect(draft.message({ input: 'Hello again' })).not.toBe(first)
    draft.sent(draft.message({ input: 'Hello again' }))
    expect(draft.message({ input: 'Hello again' })).not.toBe(first)
  })
})
