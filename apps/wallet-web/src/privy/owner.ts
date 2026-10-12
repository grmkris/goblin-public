import type { Address } from '@goblin/wallet/contract'
import { type User, useCreateWallet, usePrivy } from '@privy-io/react-auth'
import { useEffect, useMemo, useRef } from 'react'

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
 * The owner wallet among the user's accounts: Privy's embedded EVM wallet at index 0, as the Worker picks it
 * (`identity.ts`). The agent wallet the owner owns is listed too, at a higher index or as another connector, and is
 * never the owner wallet; nor is an imported key.
 */
export const ownerAddress = (user: User | null): Address | undefined => {
  const wallet = user?.linkedAccounts.find(
    (account) =>
      account.type === 'wallet' &&
      account.walletClientType === 'privy' &&
      account.chainType === 'ethereum' &&
      (account.connectorType === undefined || account.connectorType === 'embedded') &&
      !account.imported &&
      (account.walletIndex === 0 || account.walletIndex === null || account.walletIndex === undefined),
  )
  return wallet?.type === 'wallet' ? wallet.address : undefined
}

/** How long Privy gets to create the owner wallet itself after a sign-in before the app asks for it. */
const CREATE_AFTER_MS = 4000

/**
 * Privy creates the owner wallet at sign-in (`createOnLogin`). A sign-in that comes back without one would otherwise
 * wait forever, so after a few seconds signed in with no owner wallet the app asks Privy to create it, once.
 */
function useCreateMissingWallet(missing: boolean): void {
  const { createWallet } = useCreateWallet()
  const create = useRef(createWallet)
  useEffect(() => {
    create.current = createWallet
  })
  useEffect(() => {
    if (!missing) return
    const timer = setTimeout(() => {
      create.current().catch(() => {
        // expected: the wallet appeared meanwhile or Privy refused; the sign-in page's stall notice covers the rest.
      })
    }, CREATE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [missing])
}

/** The owner from Privy's state. Call it below `PrivyRoot`. */
export function useOwner(): Owner {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy()
  const address = authenticated ? ownerAddress(user) : undefined
  useCreateMissingWallet(ready && authenticated && address === undefined)
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
