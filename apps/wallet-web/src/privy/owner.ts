import type { Address } from '@goblin/wallet/contract'
import { type User, usePrivy } from '@privy-io/react-auth'
import { useMemo } from 'react'

/** The signed-in owner as the pages see them. */
export interface Owner {
  /** Privy has loaded and knows whether someone is signed in. */
  readonly ready: boolean
  readonly authenticated: boolean
  /** Privy's user id (`did:privy:…`). */
  readonly userId: string | undefined
  /** The sign-in email (or the Google account's), for display; none for an X sign-in. */
  readonly email: string | undefined
  /** The owner wallet: the embedded EVM wallet at index 0. Undefined until Privy has created it. */
  readonly address: Address | undefined
  /** Opens Privy's sign-in (email code or X). */
  readonly login: () => void
  readonly logout: () => Promise<void>
  /** A current Privy access token for `authorization: Bearer …`; null when signed out. */
  readonly getToken: () => Promise<string | null>
}

/**
 * The owner wallet among the user's accounts: Privy's embedded EVM wallet at index 0. The agent wallet the owner owns
 * is listed too, at a higher index, and is never the owner wallet.
 */
export const ownerAddress = (user: User | null): Address | undefined => {
  const wallet = user?.linkedAccounts.find(
    (account) =>
      account.type === 'wallet' &&
      account.walletClientType === 'privy' &&
      account.chainType === 'ethereum' &&
      (account.walletIndex === 0 || account.walletIndex === null || account.walletIndex === undefined),
  )
  return wallet?.type === 'wallet' ? wallet.address : undefined
}

/** The owner from Privy's state. Call it below `PrivyRoot`. */
export function useOwner(): Owner {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy()
  const address = authenticated ? ownerAddress(user) : undefined
  const email = user?.email?.address ?? user?.google?.email
  return useMemo(
    () => ({
      ready,
      authenticated,
      userId: authenticated ? user?.id : undefined,
      email: authenticated ? email : undefined,
      address,
      login: () => login(),
      logout,
      getToken: () => (authenticated ? getAccessToken() : Promise.resolve(null)),
    }),
    [ready, authenticated, user?.id, email, address, login, logout, getAccessToken],
  )
}
