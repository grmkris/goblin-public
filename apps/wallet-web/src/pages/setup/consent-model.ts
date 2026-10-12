// What the consent page shows, decided without the network: the request as the Worker answered it (or why it did not)
// and whether the owner's wallet is set up. Setup comes first, inside the consent, unless the owner connects now.
import type { Me } from '@goblin/wallet/contract'
import type { OAuthRequestView } from '../../api/types.ts'
import { isSetUp } from '../progress.ts'

export type ConsentStage =
  | { readonly kind: 'no-request' }
  | { readonly kind: 'loading' }
  /** Answered already, or forgotten: nothing to go back to. */
  | { readonly kind: 'gone' }
  /** Another wallet account opened it first. */
  | { readonly kind: 'other-owner'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  /** It ran out before the owner answered: back to the client to connect again. */
  | { readonly kind: 'expired'; readonly view: OAuthRequestView }
  | { readonly kind: 'setup'; readonly view: OAuthRequestView; readonly me: Me }
  | { readonly kind: 'approve'; readonly view: OAuthRequestView; readonly me: Me }

/** The failure as the page needs it: the Worker's code when it sent one, and its words. */
export interface Failure {
  readonly code: string | undefined
  readonly message: string
}

export function consentStage(input: {
  readonly id: string
  readonly request: OAuthRequestView | undefined
  readonly requestFailure: Failure | undefined
  readonly me: Me | undefined
  readonly meFailure: Failure | undefined
}): ConsentStage {
  const { request, requestFailure, me } = input
  if (input.id === '') return { kind: 'no-request' }
  if (requestFailure !== undefined) {
    if (requestFailure.code === 'other_owner') return { kind: 'other-owner', message: requestFailure.message }
    if (requestFailure.code === 'request_gone') return { kind: 'gone' }
    return { kind: 'failed', message: requestFailure.message }
  }
  if (request?.expired === true) return { kind: 'expired', view: request }
  if (input.meFailure !== undefined) return { kind: 'failed', message: input.meFailure.message }
  if (request === undefined || me === undefined) return { kind: 'loading' }
  return isSetUp(me) ? { kind: 'approve', view: request, me } : { kind: 'setup', view: request, me }
}

/** Where "Back to <host>" goes when the request ran out: the client's site, to connect again. */
export const clientHome = (redirectHost: string): string => `https://${redirectHost}/`

/** How often an open consent page keeps its request alive; the Worker extends it ten minutes each time. */
export const KEEP_ALIVE_MS = 120_000
