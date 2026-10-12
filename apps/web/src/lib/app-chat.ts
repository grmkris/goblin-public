// What the chat bar over an App's page says of its conversation (ADR 0053): the newest reply goblin finished since the
// owner last wrote, as one line. Pure.
import { type Part, isOwnTurn } from './parts.ts'

/** A finished reply: the part it is, and its first line of words. */
export type Reply = { readonly id: string; readonly line: string }

/** Markdown's marks at the start of a line (a heading, a quote, a list item) and its emphasis, which a line drops. */
const LEADING = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/u
const EMPHASIS = /[*_`~]+/gu

/** The first line of `text` that has words, without its Markdown marks; empty when it has none. */
export function replyLine(text: string): string {
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('```')) continue
    const line = trimmed.replace(LEADING, '').replaceAll(EMPHASIS, '').replaceAll(/\s+/gu, ' ').trim()
    if (line !== '') return line.slice(0, 200)
  }
  return ''
}

/**
 * The newest reply goblin finished after the owner's last turn, read from the end of the transcript; undefined while
 * none has (the turn is still running, or the owner wrote last).
 */
export function latestReply(parts: readonly Part[]): Reply | undefined {
  for (const part of parts.toReversed()) {
    if (isOwnTurn(part)) return undefined
    if (part.kind !== 'text' || part.live) continue
    const line = replyLine(part.text)
    if (line !== '') return { id: part.id, line }
  }
  return undefined
}
