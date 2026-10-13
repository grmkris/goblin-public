// What someone who is not signed in sees. At `/` that is the wallet's landing; every deep link (an approval, a
// subscription to sign, setup, consent, Add funds) keeps the plain sign-in, so nobody who came to answer something has
// to scroll past the pitch first. A sign-in that never finished keeps its recovery page everywhere.
import type { Auth } from './auth.tsx'
import { normalizePath } from './router.tsx'

/**
 * Keys Privy keeps in the browser while someone is signed in (`@privy-io/react-auth` 3.45). Only a hint: while Privy
 * loads, a returning owner sees the quiet sign-in page instead of the landing flashing past on the way to Home. A
 * wrong guess either way costs a moment, nothing more.
 */
const PRIVY_SESSION_KEYS = ['privy:token', 'privy:refresh_token'] as const

/** Whether this browser looks signed in to Privy. Storage that is missing or refuses to be read says no. */
export function returningOwner(storage: () => Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    const store = storage()
    return store !== undefined && PRIVY_SESSION_KEYS.some((key) => store.getItem(key) !== null)
  } catch {
    // expected: storage blocked (private mode, a sandbox); treat the visitor as new
    return false
  }
}

export function frontDoor(input: {
  readonly pathname: string
  readonly status: Exclude<Auth['status'], 'ready'>
  readonly returning: boolean
}): 'landing' | 'sign-in' {
  if (normalizePath(input.pathname) !== '/' || input.status === 'stalled') return 'sign-in'
  return input.status === 'loading' && input.returning ? 'sign-in' : 'landing'
}
