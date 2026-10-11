import { expect, it } from 'vitest'
import { SubmissionRetry } from '../src/lib/submission-retry.ts'

it('deduplicates an unchanged failed send, and distinguishes new text, attachments, references and accepted duplicates', () => {
  let next = 0
  const retry = new SubmissionRetry(() => `operation-${++next}`)
  const draft = { thread: '1', input: 'same words', context: { attachments: ['file.txt'] } }
  const first = retry.operation(draft)
  expect(retry.operation({ ...draft })).toBe(first)
  retry.accepted(first)
  expect(retry.operation(draft)).not.toBe(first)
  const attachment = retry.operation({ ...draft, context: { attachments: ['other.txt'] } })
  expect(retry.operation({ ...draft, input: 'changed' })).not.toBe(attachment)
  const reference = retry.operation({
    ...draft,
    context: { selections: [{ kind: 'connection', connectionId: 'notes' }] },
  })
  expect(retry.operation(draft)).not.toBe(reference)
  expect(retry.operation({ ...draft, thread: '2' })).not.toBe(retry.operation(draft))
})
