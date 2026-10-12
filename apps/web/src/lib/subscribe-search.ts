// The search of `/subscribe` and its return page (ADR 0054): where to go back to once subscribed, and what the Goblin
// Wallet sent the owner back with. Every value is checked here; anything else is dropped.

/** A path of this app to come back to: absolute, not protocol-relative, short. */
const pathOf = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length <= 512 &&
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.includes('\\')
    ? value
    : undefined

export interface SubscribeSearch {
  readonly return?: string
}

export const parseSubscribeSearch = (search: Record<string, unknown>): SubscribeSearch => {
  const back = pathOf(search['return'])
  return back === undefined ? {} : { return: back }
}

export interface SubscribedSearch extends SubscribeSearch {
  /** The wallet subscription the owner signed (or declined), as the wallet sent it back. */
  readonly subscription?: string
  /** The owner pressed Cancel on the wallet's page: nothing was signed. */
  readonly declined?: true
}

export const parseSubscribedSearch = (search: Record<string, unknown>): SubscribedSearch => {
  const subscription = search['subscription']
  return {
    ...parseSubscribeSearch(search),
    ...(typeof subscription === 'string' && /^sub_[0-9a-f]{32}$/u.test(subscription) ? { subscription } : {}),
    ...(search['declined'] === '1' || search['declined'] === 1 ? { declined: true as const } : {}),
  }
}
