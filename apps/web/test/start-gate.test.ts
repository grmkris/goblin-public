import { describe, expect, it } from 'vitest'
import type { BillingState, OnboardingView } from '@goblin/contracts'
import { type StartInputs, decideStart } from '../src/onboarding/hooks.ts'
import { stateOf } from '../src/onboarding/queries.ts'

const plan: BillingState = {
  active: true,
  source: 'free',
  until: null,
  dailyCredits: 200,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
  mode: null,
  plan: 'free',
  priceCents: 0,
}

/** A signed-in owner with an active plan on a page that waits for Start, Start's state not read yet. */
const inputs = (change: Partial<StartInputs> = {}): StartInputs => ({
  gated: true,
  session: 'signed-in',
  billing: { state: plan, error: '' },
  start: { data: undefined, failed: false },
  ...change,
})

describe("the shell's Start decision (ADR 0048)", () => {
  it('holds a gated page on the splash until the session, the plan and Start are known', () => {
    expect(decideStart(inputs({ session: 'checking' }))).toEqual({ kind: 'wait' })
    expect(decideStart(inputs({ billing: { state: undefined, error: '' } }))).toEqual({ kind: 'wait' })
    expect(decideStart(inputs())).toEqual({ kind: 'wait' })
  })

  it('sends an owner whose Start is open to its first open step, the welcome when the state names none', () => {
    expect(decideStart(inputs({ start: { data: { status: 'open', step: 'wallet' }, failed: false } }))).toEqual({
      kind: 'start',
      step: 'wallet',
    })
    expect(decideStart(inputs({ start: { data: { status: 'open' }, failed: false } }))).toEqual({
      kind: 'start',
      step: 'welcome',
    })
  })

  it('shows the page once Start is done or skipped, and never holds pages that do not wait for Start', () => {
    expect(decideStart(inputs({ start: { data: { status: 'done' }, failed: false } }))).toEqual({ kind: 'show' })
    expect(decideStart(inputs({ start: { data: { status: 'skipped' }, failed: false } }))).toEqual({ kind: 'show' })
    expect(decideStart(inputs({ gated: false, session: 'checking' }))).toEqual({ kind: 'show' })
  })

  it("leaves the page's own gate to sign in, report or subscribe, and lets the owner in when Start cannot be read", () => {
    expect(decideStart(inputs({ session: 'signed-out' }))).toEqual({ kind: 'show' })
    expect(decideStart(inputs({ session: 'unavailable' }))).toEqual({ kind: 'show' })
    expect(decideStart(inputs({ billing: { state: undefined, error: 'failed · ref 1' } }))).toEqual({ kind: 'show' })
    expect(decideStart(inputs({ billing: { state: { ...plan, active: false }, error: '' } }))).toEqual({
      kind: 'show',
    })
    expect(decideStart(inputs({ start: { data: undefined, failed: true } }))).toEqual({ kind: 'show' })
  })
})

/** Start's view with the steps in `done` done. */
const view = (status: OnboardingView['status'], done: readonly string[]): OnboardingView => ({
  status,
  steps: (['welcome', 'wallet', 'services', 'goblin'] as const).map((id) => ({ id, done: done.includes(id) })),
  wallet: { connected: false, allowed: false, ready: false, gaps: [], needs: '5', funded: false },
  mercator: { connected: false, allowed: false },
  connected: 0,
  kickoff: false,
})

describe("Start's state from its view", () => {
  it('names the first step still to do while Start is open, and no step once it is not', () => {
    expect(stateOf(view('open', []))).toEqual({ status: 'open', step: 'welcome' })
    expect(stateOf(view('open', ['welcome']))).toEqual({ status: 'open', step: 'wallet' })
    expect(stateOf(view('done', ['welcome']))).toEqual({ status: 'done' })
    expect(stateOf(view('skipped', []))).toEqual({ status: 'skipped' })
  })
})
