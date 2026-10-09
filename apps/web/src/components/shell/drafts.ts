import type { ComposerDraft } from '../../lib/composer.ts'

/** A draft on its way into a new thread's panel (`/new-thread`), taken once by the draft it opens. */
let pending: ComposerDraft | undefined

export function keepDraft(draft: ComposerDraft): void {
  pending = draft
}

/** The draft waiting for the new thread's composer, once; nothing the next time. */
export function takeDraft(): ComposerDraft | undefined {
  const draft = pending
  pending = undefined
  return draft
}
