// The landing hero's stream: three payments an agent asks for, meeting the owner's limits, played once as a script.
// A search fits and is paid; a $6 call is over what the signer will sign; a first payment to a new address asks the
// owner, who approves or declines it on the page (or, untouched, it approves itself so a passive visitor sees the end).
// Pure: a step and an answer in, rows and the hour's spend out. The limits are the wallet's defaults.
import { microsToUsd, usdToMicros } from '@goblin/wallet/amounts'
import { DEFAULT_LIMITS, type LimitLayer } from '@goblin/wallet/contract'

export type RequestId = 'search' | 'service' | 'send'

export interface StreamRequest {
  readonly id: RequestId
  readonly title: string
  /** Who would be paid. */
  readonly payee: string
  readonly amountUsd: string
  /** The layer that stops it: the signer refuses past its cap; the ledger asks before a first payment to an address. */
  readonly decidedBy?: LimitLayer
}

export const REQUESTS: readonly StreamRequest[] = [
  { id: 'search', title: 'Web search', payee: 'Exa, over x402', amountUsd: '0.007' },
  { id: 'service', title: 'Video transcript', payee: 'A paid service', amountUsd: '6.00', decidedBy: 'signer' },
  { id: 'send', title: 'Send USDC', payee: '0x7Ad3…Ad50, a new address', amountUsd: '1.00', decidedBy: 'ledger' },
]

/** Where a request stands. `hidden` until it arrives; `checking` while the limits look at it. */
export type Verdict = 'hidden' | 'checking' | 'paid' | 'refused' | 'asking' | 'declined'

/** The owner's answer to the one request that asks. */
export type Answer = 'approved' | 'declined' | undefined

/** One beat of the script: a request arrives or the limits answer it, `at` ms after the stream starts. */
interface Beat {
  readonly at: number
  readonly id: RequestId
  readonly verdict: Verdict
}

export const BEATS: readonly Beat[] = [
  { at: 350, id: 'search', verdict: 'checking' },
  { at: 1050, id: 'search', verdict: 'paid' },
  { at: 1750, id: 'service', verdict: 'checking' },
  { at: 2450, id: 'service', verdict: 'refused' },
  { at: 3150, id: 'send', verdict: 'checking' },
  { at: 3850, id: 'send', verdict: 'asking' },
]

/** How long the ask waits, untouched, before it approves itself. */
export const ASK_WAITS_MS = 6000

export interface StreamRow {
  readonly request: StreamRequest
  readonly verdict: Verdict
  /** The layer that refused or asked, once it has; a payment that fit passed every layer. */
  readonly layer?: LimitLayer
}

export interface StreamView {
  readonly rows: readonly StreamRow[]
  /** What the paid requests took from this hour's limit. */
  readonly usedThisHour: string
  readonly hourLimit: string
}

function verdictOf(id: RequestId, step: number, answer: Answer): Verdict {
  const beat = BEATS.slice(0, step).findLast((each) => each.id === id)
  const verdict = beat?.verdict ?? 'hidden'
  if (verdict !== 'asking' || answer === undefined) return verdict
  return answer === 'approved' ? 'paid' : 'declined'
}

/** The stream after `step` beats have played (0 to `BEATS.length`), with the owner's answer, if any. */
export function streamAt(step: number, answer: Answer): StreamView {
  const rows = REQUESTS.map((request): StreamRow => {
    const verdict = verdictOf(request.id, step, answer)
    const layer = verdict === 'hidden' || verdict === 'checking' ? undefined : request.decidedBy
    return layer === undefined ? { request, verdict } : { request, verdict, layer }
  })
  const used = rows
    .filter((row) => row.verdict === 'paid')
    .reduce((total, row) => total + usdToMicros(row.request.amountUsd), 0n)
  return { rows, usedThisHour: microsToUsd(used), hourLimit: DEFAULT_LIMITS.perHour }
}

/** The end of the story, shown at once when the visitor asks for less motion. */
export const SETTLED: StreamView = streamAt(BEATS.length, 'approved')

/** The ask is open: its request has arrived and nobody has answered it yet. */
export const isAsking = (step: number, answer: Answer): boolean => step >= BEATS.length && answer === undefined
