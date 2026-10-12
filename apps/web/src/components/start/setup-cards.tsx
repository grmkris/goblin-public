// First-run Start's place in the chat (ADR 0048). An owner whose goblin cannot answer (the free plan's wallet is not
// funded) sees what is left to set up instead of a refusal, and their message waits in the composer; one who skipped
// Start with something left gets a quiet way back. Neither asks the model anything.
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { OnboardingStep, OnboardingView } from '@goblin/contracts'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@goblin/ui'
import { CheckIcon, WalletIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { onboardingQuery } from '../../onboarding/queries.ts'

/** The steps that let goblin answer, in order, as the card names them. */
const ANSWER_STEPS: readonly { readonly id: OnboardingStep; readonly text: (view: OnboardingView) => string }[] = [
  { id: 'wallet', text: () => 'Connect your Goblin Wallet' },
  { id: 'funds', text: (view) => `Add $${view.wallet.needs} or more to it` },
]

/** Where Continue setup goes: the first step still to do. */
const firstOpen = (view: OnboardingView, among: readonly OnboardingStep[]): OnboardingStep =>
  view.steps.find((step) => among.includes(step.id) && !step.done)?.id ?? 'funds'

/** goblin cannot answer yet: what is left, and the way to finish it. The message the owner wrote stays where it is. */
export function FundGoblinCard() {
  const view = useQuery(onboardingQuery).data
  if (view === undefined) return null
  const done = (id: OnboardingStep) => view.steps.find((step) => step.id === id)?.done === true
  return (
    <section className="setup-card" aria-labelledby="fund-goblin-title">
      <p id="fund-goblin-title" className="setup-card-title">
        <WalletIcon aria-hidden />
        Fund goblin to get answers
      </p>
      <p className="setup-card-why">
        Your plan&apos;s Credits start once your Goblin Wallet holds ${view.wallet.needs}. Your message stays here.
      </p>
      <ol className="setup-card-steps">
        {ANSWER_STEPS.map((step) => (
          <li key={step.id} {...(done(step.id) ? { 'data-done': true } : {})}>
            <span className="setup-card-mark" aria-hidden>
              {done(step.id) && <CheckIcon />}
            </span>
            {step.text(view)}
            {done(step.id) && <span className="sr-only"> (done)</span>}
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        nativeButton={false}
        render={<Link to="/start/$step" params={{ step: firstOpen(view, ['wallet', 'funds']) }} />}
      >
        Continue setup
      </Button>
    </section>
  )
}

/** Start was skipped and something is left: one quiet line back to it, which the owner can put away for this visit. */
export function FinishSetupRow() {
  const view = useQuery(onboardingQuery).data
  const [hidden, setHidden] = useState(false)
  if (view === undefined || hidden || view.status !== 'skipped') return null
  const left = view.steps.filter((step) => !step.done && step.id !== 'goblin')
  if (left.length === 0) return null
  return (
    <div className="setup-row">
      <Link className="setup-row-link" to="/start/$step" params={{ step: left[0]?.id ?? 'wallet' }}>
        Finish setting up goblin
        <span className="setup-row-count">{left.length} left</span>
      </Link>
      <button type="button" className="setup-row-close" aria-label="Hide for now" onClick={() => setHidden(true)}>
        <XIcon aria-hidden />
      </button>
    </div>
  )
}

/** Settings' way back to first-run Start: how much is left, and the step to pick up from. */
export function SetupSettingsCard() {
  const view = useQuery(onboardingQuery).data
  const left = view?.steps.filter((step) => !step.done) ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up goblin</CardTitle>
        <CardDescription>
          Your Goblin Wallet and its funds, how goblin pays for its model, Mercator and your other services.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <div className="setting-row">
            <span className="grant-text">
              <span className="grant-name">
                {view === undefined
                  ? 'Reading your setup…'
                  : left.length === 0
                    ? 'All set'
                    : `${String(left.length)} steps left`}
              </span>
            </span>
            <Button
              size="sm"
              variant={left.length === 0 ? 'outline' : 'default'}
              nativeButton={false}
              render={<Link to="/start/$step" params={{ step: left[0]?.id ?? 'wallet' }} />}
            >
              {left.length === 0 ? 'Review' : 'Continue setup'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
