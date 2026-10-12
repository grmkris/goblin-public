import { useQuery } from '@tanstack/react-query'
import type { BillingState, OnboardingState, OnboardingStep } from '@goblin/contracts'
import { useBilling } from '../account/hooks.ts'
import { type SessionState, useSession } from '../auth/hooks.ts'
import { signedInStartQuery } from './queries.ts'

/**
 * What the shell does with a page that waits for first-run Start (ADR 0048): `wait` (a splash, no app around it) until
 * that is known, `start` to send the owner to Start's first open step, or `show` the page.
 */
export type StartDecision =
  | { readonly kind: 'wait' }
  | { readonly kind: 'start'; readonly step: OnboardingStep }
  | { readonly kind: 'show' }

const WAIT: StartDecision = { kind: 'wait' }
const SHOW: StartDecision = { kind: 'show' }

/** What the decision reads: the page, the session, the plan and Start's state as the cache holds them now. */
export type StartInputs = {
  readonly gated: boolean
  readonly session: SessionState
  readonly billing: { readonly state: BillingState | undefined; readonly error: string }
  readonly start: { readonly data: OnboardingState | undefined; readonly failed: boolean }
}

/**
 * Signed out or unable to check, the page's own gate takes over; a Start state that cannot be read lets the owner in,
 * since Start is help, not a lock. An open Start comes first whether or not the owner has a plan yet; otherwise the
 * page waits until the plan is known, and its own gate decides.
 */
export const decideStart = ({ gated, session, billing, start }: StartInputs): StartDecision => {
  if (!gated) return SHOW
  if (session === 'checking') return WAIT
  if (session !== 'signed-in') return SHOW
  if (start.data === undefined) return start.failed ? SHOW : WAIT
  // Start comes first, plan or not: choosing goblin Pro is one of its steps (ADR 0054). Once it is done or skipped,
  // the page's own gate sends an owner without a plan to subscribe.
  if (start.data.status === 'open') return { kind: 'start', step: start.data.step ?? 'welcome' }
  return billing.state === undefined && billing.error === '' ? WAIT : SHOW
}

/**
 * Whether the page the shell is about to draw (`gated`: it waits for Start) may show (`decideStart`). Start's state is
 * read as soon as someone is signed in, beside the plan, on every page, so moving to a gated one later waits for
 * nothing.
 */
export function useStartDecision(gated: boolean): StartDecision {
  const session = useSession().state
  const billing = useBilling()
  const start = useQuery(signedInStartQuery(session === 'signed-in'))
  return decideStart({ gated, session, billing, start: { data: start.data, failed: start.error !== null } })
}
