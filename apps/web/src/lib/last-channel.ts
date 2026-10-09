import { PRIMARY_CHAT } from '@goblin/contracts'

const KEY = 'goblin:last-channel'

/** The channel this tab showed last, which Home opens again: Personal's until one was opened. */
export function lastChannel(): string {
  try {
    const stored = sessionStorage.getItem(KEY)
    return stored !== null && /^\d{1,12}$/u.test(stored) ? stored : PRIMARY_CHAT
  } catch {
    return PRIMARY_CHAT
  }
}

/** Remembers the channel showing now, for Home (a convenience of this tab: without storage Home opens Personal). */
export function rememberChannel(channel: string): void {
  try {
    sessionStorage.setItem(KEY, channel)
  } catch {
    /* Home opens Personal instead. */
  }
}
