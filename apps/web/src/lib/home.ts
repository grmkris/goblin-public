import type { Part } from './parts.ts'
import { isOwnTurn } from './parts.ts'

export const HOME_MARK = 'home-surface'
/** Main resumes today's own turn; an older or empty conversation opens the desk below it. */
export function homeLanding(parts: readonly Part[], now = new Date()): string {
  const latest = parts.filter(isOwnTurn).at(-1)
  const at = latest?.at === undefined ? undefined : new Date(latest.at)
  return at?.toDateString() === now.toDateString() ? (latest?.id ?? HOME_MARK) : HOME_MARK
}
/** A presentation event only. The listener uses the scroller's commands, never transcript state. */
export function showHome(ids: readonly string[] = []): void {
  window.dispatchEvent(new CustomEvent('goblin-home-show', { detail: [...ids] }))
}
