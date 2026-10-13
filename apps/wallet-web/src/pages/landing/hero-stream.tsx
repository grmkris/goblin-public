// The hero's one moving moment: an agent's payments meeting the owner's limits, played once on load. The visitor can
// answer the last one; left alone, it approves itself after a few seconds, so a passive visitor still sees the end.
// With less motion asked for, it shows the settled story at once.
import { Button, Meter, Spinner, useMediaQuery } from '@goblin/ui'
import { usdToMicros } from '@goblin/wallet/amounts'
import { DEFAULT_LIMITS } from '@goblin/wallet/contract'
import { Captions, Search, Send } from 'lucide-react'
import { type ComponentType, type ReactNode, type SVGProps, useCallback, useEffect, useState } from 'react'
import { cn, formatUsd, LayerBadge } from '../../ui/index.ts'
import { formatUsdCompact } from '../../ui/format.ts'
import { priceOf } from '../subscription-model.ts'
import {
  type Answer,
  ASK_WAITS_MS,
  BEATS,
  isAsking,
  type RequestId,
  SETTLED,
  type StreamRow,
  type StreamView,
  streamAt,
} from './stream-model.ts'

const ICON: Record<RequestId, ComponentType<SVGProps<SVGSVGElement>>> = {
  search: Search,
  service: Captions,
  send: Send,
}

/** How long the self-approval shows its press before it lands. */
const PRESS_MS = 180

/** Plays the beats once the page is visible, so a tab opened in the background does not play to nobody. */
function useStep(): number {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const play = () => {
      BEATS.forEach((beat, index) => timers.push(setTimeout(() => setStep(index + 1), beat.at)))
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', onVisible)
      play()
    }
    if (document.visibilityState === 'visible') play()
    else document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      timers.forEach(clearTimeout)
    }
  }, [])
  return step
}

/**
 * The open ask approves itself after `ASK_WAITS_MS` untouched. A pointer over the stream or focus inside it holds the
 * wait, so it never answers under someone's finger; leaving starts the wait again.
 */
function useSelfApproval(asking: boolean, held: boolean, approve: () => void): boolean {
  const [pressing, setPressing] = useState(false)
  useEffect(() => {
    if (!asking || held) return
    let landing: ReturnType<typeof setTimeout> | undefined
    const wait = setTimeout(() => {
      setPressing(true)
      landing = setTimeout(() => {
        setPressing(false)
        approve()
      }, PRESS_MS)
    }, ASK_WAITS_MS)
    return () => {
      clearTimeout(wait)
      if (landing !== undefined) clearTimeout(landing)
      setPressing(false)
    }
  }, [asking, held, approve])
  return pressing
}

type Tone = 'success' | 'attention' | 'quiet' | 'refused'

const DOT: Record<Tone, string> = {
  success: 'bg-success',
  attention: 'bg-attention',
  quiet: 'bg-muted-foreground/50',
  refused: 'ring-1 ring-muted-foreground ring-inset',
}

/** One verdict: a dot, its word, why, and the layer that said so. */
function Mark({
  tone,
  label,
  children,
  row,
}: {
  readonly tone: Tone
  readonly label: string
  readonly children: ReactNode
  readonly row?: StreamRow
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1.5 font-medium">
        <span aria-hidden className={cn('size-1.5 rounded-full', DOT[tone])} />
        {label}
      </span>
      <span className="text-muted-foreground">{children}</span>
      {row?.layer !== undefined && <LayerBadge layer={row.layer} />}
    </span>
  )
}

const Checking = () => (
  <span className="flex items-center gap-1.5 text-muted-foreground">
    <Spinner aria-hidden className="size-3.5" />
    Checking your limits
  </span>
)

/** What the limits said: paid, refused, or, for the ask, that it asked and how it was answered. */
function Verdict({ row }: { readonly row: StreamRow }) {
  if (row.verdict === 'hidden' || row.verdict === 'checking') return <Checking />
  if (row.request.id === 'send') {
    const [tone, label]: readonly [Tone, string] =
      row.verdict === 'asking'
        ? ['attention', 'Asks you']
        : row.verdict === 'declined'
          ? ['quiet', 'You declined']
          : ['success', 'You approved']
    return (
      <Mark tone={tone} label={label} row={row}>
        First payment to this address
      </Mark>
    )
  }
  if (row.verdict === 'refused')
    return (
      <Mark tone="refused" label="Refused" row={row}>
        Over {priceOf(DEFAULT_LIMITS.perCall)} a payment
      </Mark>
    )
  return (
    <Mark tone="success" label="Paid">
      On Base, from your allowance
    </Mark>
  )
}

/** The ask's second line: Approve and Decline while it is open, then what came of the answer, in the same place. */
function Answering({
  row,
  pressing,
  onAnswer,
}: {
  readonly row: StreamRow
  readonly pressing: boolean
  readonly onAnswer: (answer: Exclude<Answer, undefined>) => void
}) {
  const open = row.verdict === 'asking'
  const settled = row.verdict === 'paid' || row.verdict === 'declined'
  return (
    <span className="stream-swap col-span-2 col-start-2 text-13">
      <span
        className={cn(
          'flex gap-2 transition-opacity duration-200',
          !open && 'pointer-events-none invisible opacity-0',
          pressing && 'stream-pressed',
        )}
      >
        <Button type="button" size="lg" tabIndex={open ? undefined : -1} onClick={() => onAnswer('approved')}>
          Approve
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          tabIndex={open ? undefined : -1}
          onClick={() => onAnswer('declined')}
        >
          Decline
        </Button>
      </span>
      {settled && (
        <span key={row.verdict} role="status" className="stream-verdict">
          {row.verdict === 'paid' ? (
            <Mark tone="success" label="Paid">
              On Base, gas 0.0073 USDC
            </Mark>
          ) : (
            <Mark tone="quiet" label="Not paid">
              Nothing was sent
            </Mark>
          )}
        </span>
      )}
    </span>
  )
}

function Row({
  row,
  pressing,
  onAnswer,
}: {
  readonly row: StreamRow
  readonly pressing: boolean
  readonly onAnswer: (answer: Exclude<Answer, undefined>) => void
}) {
  const Icon = ICON[row.request.id]
  return (
    <li
      data-verdict={row.verdict}
      aria-hidden={row.verdict === 'hidden' ? true : undefined}
      className="stream-row grid grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-4"
    >
      <span
        aria-hidden
        className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4"
      >
        <Icon strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold">{row.request.title}</span>
        <span className="truncate text-13 text-muted-foreground">{row.request.payee}</span>
      </span>
      <span className="text-base font-semibold tracking-tight tabular-nums">{formatUsd(row.request.amountUsd)}</span>
      <span key={row.layer ?? row.verdict} className="stream-verdict col-span-2 col-start-2 text-13">
        <Verdict row={row} />
      </span>
      {row.request.id === 'send' && <Answering row={row} pressing={pressing} onAnswer={onAnswer} />}
    </li>
  )
}

/** The panel's foot: the wallet's limits, and this hour's spend filling its meter as payments land. */
function Limits({ view }: { readonly view: StreamView }) {
  const share = Number((usdToMicros(view.usedThisHour) * 1000n) / usdToMicros(view.hourLimit)) / 10
  return (
    <div className="flex flex-col gap-2.5 border-t border-border bg-muted/50 px-4 py-3.5 sm:px-5">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-13">
        <span>
          <span className="font-semibold tabular-nums">{priceOf(DEFAULT_LIMITS.perCall)}</span>{' '}
          <span className="text-muted-foreground">a payment</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums">{priceOf(DEFAULT_LIMITS.perHour)}</span>{' '}
          <span className="text-muted-foreground">an hour</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums">{priceOf(DEFAULT_LIMITS.perWeek)}</span>{' '}
          <span className="text-muted-foreground">a week</span>
        </span>
      </p>
      <div className="stream-meter flex items-center gap-3">
        <Meter
          value={share}
          min={0}
          max={100}
          aria-label={`${formatUsdCompact(view.usedThisHour)} of ${priceOf(view.hourLimit)} used this hour`}
        />
        <span aria-hidden className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatUsdCompact(view.usedThisHour)} of {priceOf(view.hourLimit)} this hour
        </span>
      </div>
    </div>
  )
}

/** The hero panel's content: the rows, then its foot of limits. The frame around them is `MossFrame`'s. */
export function HeroStream() {
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  const step = useStep()
  const [answer, setAnswer] = useState<Answer>(undefined)
  const [held, setHeld] = useState(false)
  const approve = useCallback(() => setAnswer('approved'), [])
  const pressing = useSelfApproval(!reduce && isAsking(step, answer), held, approve)
  const view = reduce ? SETTLED : streamAt(step, answer)
  return (
    <div
      className="flex h-full flex-col justify-between"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false)
      }}
    >
      <ul className="flex flex-col divide-y divide-border px-4 sm:px-5">
        {view.rows.map((row) => (
          <Row key={row.request.id} row={row} pressing={pressing} onAnswer={setAnswer} />
        ))}
      </ul>
      <Limits view={view} />
    </div>
  )
}
