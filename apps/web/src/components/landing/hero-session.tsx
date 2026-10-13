// The landing's one orchestrated moment: a short goblin session playing in the hero's panel, as the app draws it. The
// owner asks for a ferry and a price watch, goblin asks Ferryhopper, its picker opens in the chat (a real screenshot),
// and goblin asks before it spends: the visitor can press Allow (or Not now) themselves. Left alone on screen for about
// six seconds, it allows on its own, so someone only watching still sees the end.
//
// The entrances are CSS (landing.css): they start with the first paint, before any script, and run off the main
// thread. The script follows the same clock (the entrances' own animation time) for the orb and its words, and owns the
// answer. Every part is laid out from the start, so nothing below moves as the session plays. Under reduced motion the
// session is already at its question, and the answer swaps in without movement.
import { type RefObject, useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, CheckIcon, KeyRoundIcon, SailboatIcon, XIcon } from 'lucide-react'
import { Button, PresenceOrb, type PresenceState } from '@goblin/ui'
import ferryPicker from '../../assets/landing/ferry-picker.webp'

/**
 * When each step starts, in ms from the session's first paint: the entrances in landing.css (`--at` on `.hero-you`,
 * `.hero-tool`, `.hero-app`, `.hero-text` and `.hero-ask-step`) start at the same moments.
 */
const STEPS = [
  { at: 150, stage: 'thinking' },
  { at: 700, stage: 'tool' },
  { at: 1800, stage: 'writing' },
  { at: 3400, stage: 'waiting' },
] as const
/** How long the question waits on screen before it answers itself. */
const AUTO_ALLOW_MS = 6000
/** How long goblin "writes" after the answer before its last line. */
const SETTLE_MS = 900

type Stage = 'ready' | (typeof STEPS)[number]['stage'] | 'settling' | 'done'
type Answer = 'waiting' | 'allowed' | 'declined'

/** The orb and the words beside it, per stage: cool while goblin works, warm while it waits on you. */
const STATUS: Readonly<Record<Stage, { readonly orb: PresenceState; readonly label: string }>> = {
  ready: { orb: 'idle', label: 'Ready' },
  thinking: { orb: 'thinking', label: 'Thinking' },
  tool: { orb: 'tool', label: 'Asking Ferryhopper' },
  writing: { orb: 'responding', label: 'Writing' },
  waiting: { orb: 'waiting', label: 'Waiting for you' },
  settling: { orb: 'responding', label: 'Writing' },
  done: { orb: 'idle', label: 'Ready' },
}

/** How far the entrances have played, from the first one's own animation clock; none under reduced motion. */
function playedMs(root: HTMLElement | null): number | undefined {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
  // The last entrance's clock: it runs until the question is on screen, and holds there.
  const time = root?.querySelector('[data-clock]')?.getAnimations()[0]?.currentTime
  return typeof time === 'number' ? time : undefined
}

/** Where the session stands: it follows the entrances as they play, then the answer. */
function useSession(root: RefObject<HTMLElement | null>, ask: RefObject<HTMLElement | null>) {
  const [stage, setStage] = useState<Stage>('ready')
  const [answer, setAnswer] = useState<Answer>('waiting')

  useEffect(() => {
    const played = playedMs(root.current)
    // Reduced motion (or no entrances to follow): the session is already at its question.
    const steps = played === undefined ? [{ at: 0, stage: 'waiting' as const }] : STEPS
    const timers = steps.map(({ at, stage: next }) =>
      window.setTimeout(
        () => setStage((now) => (now === 'settling' || now === 'done' ? now : next)),
        Math.max(0, at - (played ?? 0)),
      ),
    )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [root])

  // Left alone on screen, the question answers itself: the clock runs only while the card is mostly in view.
  const waiting = stage === 'waiting' && answer === 'waiting'
  useEffect(() => {
    const card = ask.current
    if (!waiting || card === null) return undefined
    let timer: number | undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        window.clearTimeout(timer)
        timer =
          entry?.isIntersecting === true ? window.setTimeout(() => setAnswer('allowed'), AUTO_ALLOW_MS) : undefined
      },
      { threshold: 0.6 },
    )
    observer.observe(card)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [waiting, ask])

  // After the answer goblin writes for a moment, then says what happens next.
  const answered = answer !== 'waiting'
  useEffect(() => {
    if (!answered) return undefined
    const write = window.setTimeout(() => setStage('settling'), 0)
    const done = window.setTimeout(() => setStage('done'), SETTLE_MS)
    return () => {
      window.clearTimeout(write)
      window.clearTimeout(done)
    }
  }, [answered])

  return { stage, answer, decide: setAnswer }
}

/** The status in the panel's top bar: the orb and what goblin is doing. */
export function HeroStatus({ stage }: { readonly stage: Stage }) {
  const { orb, label } = STATUS[stage]
  return (
    <span className="hero-status">
      <span aria-hidden>{label}</span>
      <PresenceOrb state={orb} label={label} />
    </span>
  )
}

/** The session's transcript, with its status rendered by the caller beside the panel's name. */
export function useHeroSession() {
  const root = useRef<HTMLOListElement>(null)
  const ask = useRef<HTMLDivElement>(null)
  const session = useSession(root, ask)
  return { ...session, root, ask }
}

export function HeroSession({ session }: { readonly session: ReturnType<typeof useHeroSession> }) {
  const { stage, answer, decide, root, ask } = session
  return (
    <ol ref={root} className="hero-session" aria-label="A goblin session">
      <li className="hero-step hero-you">Find a ferry to Naxos on Saturday and watch the price.</li>
      <li className="hero-step hero-tool">
        <span className="hero-tool-asking">
          <span aria-hidden className="hero-tool-dot" />
          Asking Ferryhopper…
        </span>
        <span className="hero-tool-used">
          <span aria-hidden className="hero-tool-dot" data-done />
          Used <b>Ferryhopper</b>
        </span>
      </li>
      <li className="hero-step hero-app">
        <span className="hero-app-bar">
          <span aria-hidden className="hero-app-tile">
            <SailboatIcon />
          </span>
          Ferryhopper
        </span>
        <img
          className="hero-app-shot"
          src={ferryPicker}
          width={1100}
          height={379}
          decoding="async"
          alt="Ferryhopper's picker in the chat: Piraeus to Naxos on Saturday 24 October, Blue Star 1 at 07:25 for €52.50 a person, the cheapest, and a Seajets sailing at 09:30 for €69.70, the fastest."
        />
      </li>
      <li className="hero-step hero-text">
        Two sailings on Saturday. Blue Star 1 is the cheapest, at <span className="tabular-nums">€52.50</span> a person.
      </li>
      <li className="hero-step hero-ask-step" data-clock>
        <HeroAsk card={ask} answer={answer} decide={decide} />
      </li>
      <li className="hero-final" data-shown={stage === 'done' ? '' : undefined} aria-hidden={stage !== 'done'}>
        <span data-variant="allowed" data-current={answer !== 'declined' ? '' : undefined}>
          Watching it. I'll message you on Telegram if it drops below <span className="tabular-nums">€50</span>.
        </span>
        <span data-variant="declined" data-current={answer === 'declined' ? '' : undefined}>
          Okay, I won't watch it. Ask me again any time.
        </span>
      </li>
    </ol>
  )
}

/** goblin's question, as the app's approval card asks it: Not now or Allow, then what came of the answer. */
function HeroAsk({
  card,
  answer,
  decide,
}: {
  readonly card: RefObject<HTMLDivElement | null>
  readonly answer: Answer
  readonly decide: (answer: Answer) => void
}) {
  const answered = answer !== 'waiting'
  return (
    <div ref={card} className="hero-ask" data-answered={answered ? '' : undefined}>
      <p className="hero-ask-head">
        <KeyRoundIcon aria-hidden />
        <span>
          <b>Mercator</b> wants to run a paid job
        </span>
      </p>
      <p className="hero-ask-detail">
        Check this fare every morning, <span className="tabular-nums">$0.007</span> a check. That is within your{' '}
        <span className="tabular-nums">$5</span> limit a job.
      </p>
      <div className="hero-ask-foot">
        <div className="hero-ask-actions" inert={answered}>
          <Button variant="ghost" size="lg" onClick={() => decide('declined')}>
            Not now
          </Button>
          <Button size="lg" onClick={() => decide('allowed')}>
            Allow
          </Button>
        </div>
        <p className="hero-ask-receipt" role="status">
          {answer === 'allowed' && (
            <>
              <CheckIcon aria-hidden />
              <span>
                Allowed. <span className="tabular-nums">$0.007</span> paid from your Goblin Wallet.
              </span>
            </>
          )}
          {answer === 'declined' && (
            <>
              <XIcon aria-hidden />
              <span>Not now. Nothing was paid.</span>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

/** The foot of the panel: the channel's composer as the app draws it, a picture only (nothing here takes input). */
export function HeroComposer() {
  return (
    <div aria-hidden className="hero-composer">
      <span>Message #Islands</span>
      <span className="hero-composer-send">
        <ArrowUpIcon />
      </span>
    </div>
  )
}
