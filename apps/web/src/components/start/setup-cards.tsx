// First-run Start's ways back (ADR 0048): a quiet row in the chat for an owner who skipped Start with something left,
// Settings' card and Activity's checklist. What goblin needs before it answers, a plan, is the plan card's
// (`plan-needed.tsx`). None of them asks the model anything.
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { OnboardingStep, OnboardingView } from '@goblin/contracts'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@goblin/ui'
import { CheckIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { onboardingQuery } from '../../onboarding/queries.ts'
import { PageSection } from '../page-section.tsx'

/** The steps a skipped Start still counts as left: the welcome and the kickoff are no tasks to come back to. */
const leftOf = (view: OnboardingView) =>
  view.steps.filter((step) => !step.done && step.id !== 'welcome' && step.id !== 'goblin')

/** Start was skipped and something is left: one quiet line back to it, which the owner can put away for this visit. */
export function FinishSetupRow() {
  const view = useQuery(onboardingQuery).data
  const [hidden, setHidden] = useState(false)
  if (view === undefined || hidden || view.status !== 'skipped') return null
  const left = leftOf(view)
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
  // A finished Start has nothing left, whatever optional step was passed by; an open one counts tasks only.
  const left = view === undefined || view.status === 'done' ? [] : leftOf(view)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up goblin</CardTitle>
        <CardDescription>
          Your Goblin Wallet, the outside services goblin reaches (Mercator first), and what goblin is for.
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
                    : `${String(left.length)} ${left.length === 1 ? 'step' : 'steps'} left`}
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

/** Each step as Activity's checklist names it. */
const STEP_NAMES: Readonly<Record<OnboardingStep, string>> = {
  welcome: 'See what goblin is',
  wallet: 'Set up and fund your Goblin Wallet',
  services: 'Connect outside services, Mercator first',
  goblin: 'Tell goblin what it is for',
}

/** Activity's Get started: first-run Start's steps, each a way back to it, while any is left. */
export function StartChecklist({ view }: { readonly view: OnboardingView | undefined }) {
  if (view === undefined || view.steps.every((step) => step.done)) return null
  const left = view.steps.filter((step) => !step.done).length
  return (
    <PageSection id="get-started" title="Get started" count={left}>
      <ul className="list-rows setup-list">
        {view.steps.map((step) => (
          <li key={step.id} {...(step.done ? { 'data-done': true } : {})}>
            <Link className="setup-list-row" to="/start/$step" params={{ step: step.id }}>
              <span className="setup-card-mark" aria-hidden>
                {step.done && <CheckIcon />}
              </span>
              <span>{STEP_NAMES[step.id]}</span>
              {step.done && <span className="sr-only"> (done)</span>}
            </Link>
          </li>
        ))}
      </ul>
    </PageSection>
  )
}
