import { describe, expect, it } from 'vitest'
import type { Attachment } from '@goblin/contracts'
import { AttachmentDraft } from '../src/lib/attachment-draft.ts'

const file = () => new File(['example'], 'example.txt', { type: 'text/plain' })
const uploaded: Attachment = { path: '/uploads/example.txt', name: 'example.txt', size: 7, mimeType: 'text/plain' }
const missingUpload = () => {
  throw new Error('upload not started')
}

describe('portable attachment draft', () => {
  it('keeps the source on failure and retries the same item without duplication', async () => {
    let attempts = 0
    const source = file()
    const draft = new AttachmentDraft(async (picked) => {
      expect(picked).toBe(source)
      attempts += 1
      if (attempts === 1) throw new Error('Connection lost. Try again.')
      return uploaded
    })
    await draft.add([source])
    expect(draft.snapshot()).toMatchObject([{ id: 1, state: 'failed', reason: 'Connection lost. Try again.' }])
    await draft.retry(1)
    expect(draft.snapshot()).toEqual([{ id: 1, name: source.name, state: 'ready', file: uploaded }])
    expect(attempts).toBe(2)
  })

  it('shares an in-flight upload with the next subscriber and never resurrects a removed file', async () => {
    let finish: (value: Attachment) => void = missingUpload
    const draft = new AttachmentDraft(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const add = draft.add([file()])
    const nextSnapshots: unknown[] = []
    const stop = draft.subscribe(() => nextSnapshots.push(draft.snapshot()))
    draft.remove(1)
    finish(uploaded)
    await add
    expect(draft.snapshot()).toEqual([])
    expect(nextSnapshots.every((snapshot) => Array.isArray(snapshot) && snapshot.length === 0)).toBe(true)
    stop()
  })

  it('refuses duplicate retries and clears failures without retaining picked files', async () => {
    let attempts = 0
    let finish: (value: Attachment) => void = missingUpload
    const draft = new AttachmentDraft(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Upload failed')
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    await draft.add([file()])
    const retry = draft.retry(1)
    await draft.retry(1)
    expect(attempts).toBe(2)
    draft.clear()
    finish(uploaded)
    await retry
    expect(draft.snapshot()).toEqual([])
  })
})
