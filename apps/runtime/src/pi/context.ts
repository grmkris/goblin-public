import type { ConversationId, EntryId, Harness } from '@earendil-works/pi-durable'

/** The context every pi-durable call takes: cancellation plus keyed values (chord's `Context`). */
export type PiContext = Parameters<Harness['close']>[0]

/**
 * Chord's `BACKGROUND_CONTEXT` for calls made outside a Pi task: no values, never cancelled. pi-durable does not
 * export chord's helpers, so this is the same structural value PiHarness inlines (`agents/harness/pi` context.ts).
 */
export const BACKGROUND: PiContext = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => '[Context purrable background]',
})

/** A Pi entry id from its number. SAFETY: Pi ids are plain integers at runtime; the brand only types them. */
export const entryId = (id: number): EntryId => id as EntryId

/** A Pi conversation id from a session id. SAFETY: PiHarness session ids are Pi's integer ids as strings. */
export const conversationId = (session: string): ConversationId => Number(session) as ConversationId
