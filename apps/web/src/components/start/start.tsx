// First-run Start (ADR 0048): one task per screen before the chats, on the rail's own green. The panel lists the steps
// (each a link; a sign-in Start began comes back to its step); the task says why, offers one action, and shows when it
// is done. Finishing narrows the panel into the rail as the chat appears: the one motion of the page.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ONBOARDING_STEPS, PRIMARY_CHAT, type OnboardingStep, type OnboardingView } from '@goblin/contracts'
import { Button, GoblinMark, Receipt } from '@goblin/ui'
import { CheckIcon, CircleAlertIcon, CircleCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { submitMutation } from '../../conversations/queries.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { changeOnboardingMutation, onboardingQuery } from '../../onboarding/queries.ts'
import { messageBody } from '../use-conversation.ts'
import { FundsStep, GoblinStep, MercatorStep, MoreStep, PayStep, STEP_TEXT, WalletStep } from './steps.tsx'

/** How a sign-in Start began came back (the callback's own words): connected, or why not. */
export type StartSearch = { readonly connected?: string; readonly error?: string; readonly ref?: string }

/** How long the panel takes to become the rail (`--start-leave` in start.css). */
const LEAVE_MS = 320

/** Opens the chat, after the panel has narrowed into the rail (at once when the owner asks for less motion). */
function useLeave(): { readonly leaving: boolean; readonly leave: () => void } {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  const leave = () => {
    const go = () => {
      navigate({ to: '/c/$chatId', params: { chatId: PRIMARY_CHAT } }).catch(reportUnexpected)
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return go()
    setLeaving(true)
    window.setTimeout(go, LEAVE_MS)
  }
  return { leaving, leave }
}

/** The step list on the panel: done, here, or still to do, each a link. */
function StepList({ view, step }: { readonly view: OnboardingView | undefined; readonly step: OnboardingStep }) {
  return (
    <ol className="start-steps">
      {ONBOARDING_STEPS.map((id, index) => {
        const done = view?.steps.find((each) => each.id === id)?.done === true
        return (
          <li key={id}>
            <Link
              to="/start/$step"
              params={{ step: id }}
              className="start-step"
              // The router marks the active link `aria-current="page"` itself; the step Start is on is marked here.
              {...(id === step ? { 'data-current': true } : {})}
              {...(done ? { 'data-done': true } : {})}
            >
              <span className="start-step-mark" aria-hidden>
                <CheckIcon className="start-step-check" />
                <span className="start-step-number">{index + 1}</span>
              </span>
              <span>{STEP_TEXT[id].label}</span>
              {done && <span className="sr-only"> (done)</span>}
            </Link>
          </li>
        )
      })}
    </ol>
  )
}

/** The green panel: goblin's mark, the steps (a count and a bar on a phone), and the way out. */
function StartPanel({
  view,
  step,
  onSkip,
}: {
  readonly view: OnboardingView | undefined
  readonly step: OnboardingStep
  readonly onSkip: () => void
}) {
  const index = ONBOARDING_STEPS.indexOf(step)
  return (
    <aside className="start-panel" aria-label="Setting up goblin">
      <div className="start-brand">
        <span className="start-mark">
          <GoblinMark />
        </span>
        <span className="start-brand-name">Set up goblin</span>
      </div>
      <StepList view={view} step={step} />
      <p className="start-count">
        Step {index + 1} of {ONBOARDING_STEPS.length}
      </p>
      <progress className="start-progress" aria-hidden value={index + 1} max={ONBOARDING_STEPS.length} />
      <button type="button" className="start-skip" onClick={onSkip}>
        Skip setup
      </button>
    </aside>
  )
}

/** What the sign-in Start began came back with, said once on the step it returned to. */
function ReturnNotice({ search }: { readonly search: StartSearch }) {
  if (search.error !== undefined)
    return (
      <Receipt tone="error">
        <CircleAlertIcon aria-hidden />
        <span>
          The sign-in did not finish ({search.error})
          {search.ref === undefined ? '' : ` · ref ${search.ref.slice(0, 8)}`}. Try again.
        </span>
      </Receipt>
    )
  if (search.connected !== undefined)
    return (
      <Receipt tone="neutral">
        <CircleCheckIcon aria-hidden />
        <span>Connected.</span>
      </Receipt>
    )
  return null
}

/** The step's task, once Start's state is read, or what stops it. */
function StepBody({
  step,
  read,
  starting,
  onStart,
}: {
  readonly step: OnboardingStep
  readonly read: { readonly data: OnboardingView | undefined; readonly error: unknown }
  readonly starting: boolean
  readonly onStart: (text: string) => void
}) {
  const view = read.data
  if (view === undefined)
    return read.error === null ? (
      <p role="status" className="start-note">
        Reading your setup…
      </p>
    ) : (
      <Receipt tone="error">
        <CircleAlertIcon aria-hidden />
        <span>{messageOf(read.error, 'read your setup')}</span>
      </Receipt>
    )
  if (step === 'wallet') return <WalletStep view={view} />
  if (step === 'funds') return <FundsStep view={view} />
  if (step === 'pay') return <PayStep />
  if (step === 'mercator') return <MercatorStep view={view} />
  if (step === 'more') return <MoreStep />
  return <GoblinStep view={view} pending={starting} onStart={onStart} />
}

/** Back on the left; on (or skip this step) on the right; the last step finishes instead. */
function StartNav({
  step,
  done,
  finishing,
  onFinish,
}: {
  readonly step: OnboardingStep
  readonly done: boolean
  readonly finishing: boolean
  readonly onFinish: () => void
}) {
  const navigate = useNavigate()
  const change = useMutation(changeOnboardingMutation)
  const index = ONBOARDING_STEPS.indexOf(step)
  const to = (other: OnboardingStep | undefined) => {
    if (other !== undefined) navigate({ to: '/start/$step', params: { step: other } }).catch(reportUnexpected)
  }
  const next = () => {
    // How goblin pays and more services are the owner's word; the agent reads the rest from the servers.
    if (step === 'pay' || step === 'more') change.mutate({ step })
    to(ONBOARDING_STEPS[index + 1])
  }
  return (
    <footer className="start-nav">
      {index > 0 ? (
        <Button variant="ghost" onClick={() => to(ONBOARDING_STEPS[index - 1])}>
          Back
        </Button>
      ) : (
        <span />
      )}
      {step === 'goblin' ? (
        <Button variant="ghost" pending={finishing} onClick={onFinish}>
          Finish without it
        </Button>
      ) : (
        <Button variant={done ? 'default' : 'ghost'} onClick={next}>
          {done ? 'Continue' : 'Skip this step'}
        </Button>
      )}
    </footer>
  )
}

export function StartPage({ step, search }: { readonly step: OnboardingStep; readonly search: StartSearch }) {
  const read = useQuery({ ...onboardingQuery, refetchInterval: step === 'funds' ? 15_000 : false })
  const change = useMutation(changeOnboardingMutation)
  const submit = useMutation(submitMutation)
  const { leaving, leave } = useLeave()
  const index = ONBOARDING_STEPS.indexOf(step)
  const done = read.data?.steps[index]?.done === true || step === 'pay' || step === 'more'
  const finish = async (kickoff?: string) => {
    if (kickoff !== undefined)
      await submit.mutateAsync({ id: PRIMARY_CHAT, message: messageBody(kickoff, crypto.randomUUID()) })
    await change.mutateAsync({ status: 'done', step: 'goblin', ...(kickoff === undefined ? {} : { kickoff: true }) })
    leave()
  }
  const failure = submit.error ?? change.error
  return (
    <div className="start" {...(leaving ? { 'data-leaving': true } : {})}>
      <StartPanel
        view={read.data}
        step={step}
        onSkip={() => change.mutate({ status: 'skipped' }, { onSuccess: leave })}
      />
      <section className="start-task" aria-labelledby="start-title">
        <header className="start-head">
          <h1 id="start-title">{STEP_TEXT[step].title}</h1>
          <p>{STEP_TEXT[step].why}</p>
        </header>
        <ReturnNotice search={search} />
        <StepBody step={step} read={read} starting={submit.isPending} onStart={(kickoff) => void finish(kickoff)} />
        {failure !== null && (
          <Receipt tone="error">
            <CircleAlertIcon aria-hidden />
            <span>{messageOf(failure, 'finish setting up')}</span>
          </Receipt>
        )}
        <StartNav
          step={step}
          done={done}
          finishing={change.isPending && !submit.isPending}
          onFinish={() => void finish()}
        />
      </section>
    </div>
  )
}
