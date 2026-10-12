// Setup's second task, on one screen: the limits in words with a small Change, the three confirmations as a list that
// follows along (and survives a reload, since what is done comes from /api/me), and one button that runs them.
import {
  Alert,
  AlertDescription,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Spinner,
} from '@goblin/ui'
import type { Me } from '@goblin/wallet/contract'
import { Check, ChevronDown, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../ui/index.ts'
import { isPerHour } from '../per-hour.ts'
import { PerHourField } from '../setup-actions.tsx'
import {
  confirmationsText,
  DEFAULT_CHOICE,
  hourlyCap,
  isDays,
  type ItemState,
  limitsSentence,
  MAX_DAYS,
  type SpendingChoice,
  spendingItems,
} from './model.ts'
import { useTurnOnSpending } from './spending.ts'
import { ScreenHeader } from './ui.tsx'

function ItemMark({ state, index }: { readonly state: ItemState; readonly index: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums',
        state === 'done' && 'bg-moss text-moss-foreground',
        state === 'active' && 'bg-foreground text-background',
        state === 'failed' && 'bg-destructive/15 text-destructive',
        state === 'todo' && 'bg-muted text-muted-foreground',
      )}
    >
      {state === 'done' && <Check className="size-3.5" />}
      {state === 'active' && <Spinner className="size-3.5" />}
      {state === 'failed' && <X className="size-3.5" />}
      {state === 'todo' && index + 1}
    </span>
  )
}

const STATE_WORDS: Record<ItemState, string> = {
  done: 'done',
  active: 'confirm it in the window that opened',
  failed: 'did not finish',
  todo: 'to do',
}

function Confirmations({ items }: { readonly items: ReturnType<typeof spendingItems> }) {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item, index) => (
        <li key={item.id} className="flex items-center gap-3">
          <ItemMark state={item.state} index={index} />
          <span className={cn('text-sm', item.state === 'todo' && 'text-muted-foreground')}>
            {item.label}
            <span className="sr-only">: {STATE_WORDS[item.state]}</span>
          </span>
          {item.state === 'active' && (
            <span aria-hidden className="ms-auto text-xs text-muted-foreground">
              Confirm in the window
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

/** The allowance per hour and how many days it lasts, folded away behind "Change". */
function ChangeLimits({
  choice,
  onChange,
}: {
  readonly choice: { readonly perHour: string; readonly days: string }
  readonly onChange: (choice: { readonly perHour: string; readonly days: string }) => void
}) {
  const daysInvalid = !isDays(choice.days) && choice.days !== '' ? true : undefined
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-muted/50 p-4">
      <PerHourField
        id="setup-per-hour"
        value={choice.perHour}
        chainName="Base"
        onChange={(perHour) => onChange({ ...choice, perHour })}
      />
      <Field data-invalid={daysInvalid}>
        <FieldLabel htmlFor="setup-days">Days</FieldLabel>
        <Input
          id="setup-days"
          inputMode="numeric"
          autoComplete="off"
          value={choice.days}
          aria-invalid={daysInvalid}
          onChange={(event) => onChange({ ...choice, days: event.target.value.trim() })}
          className="max-w-24"
        />
        {daysInvalid && <FieldError>Enter 1 to {MAX_DAYS} days.</FieldError>}
      </Field>
    </div>
  )
}

function HowItWorks() {
  return (
    <Collapsible className="flex flex-col">
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" size="sm" className="group/fold self-center" />}
      >
        How this works
        <ChevronDown
          data-icon="inline-end"
          aria-hidden
          className="group-data-panel-open/fold:rotate-180 motion-safe:transition-transform"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 pt-3 text-sm/relaxed text-muted-foreground text-pretty">
          <p>
            Your address stays the same and your money stays in it. The upgrade (EIP-7702) lets your account run
            MetaMask&apos;s DeleGator, so it can grant an allowance. The upgrade is a UserOperation whose gas a
            paymaster takes in USDC from your account, at most $0.10.
          </p>
          <p>
            The allowance is an ERC-7710 delegation: your agent may move up to the hourly amount from your account to
            itself, until it expires. The chain enforces it; you can revoke it any time.
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SpendingStep({
  me,
  step,
  total,
  level,
}: {
  readonly me: Me
  readonly step: number
  readonly total: number
  readonly level: 1 | 2
}) {
  const [draft, setDraft] = useState({ perHour: DEFAULT_CHOICE.perHour, days: String(DEFAULT_CHOICE.days) })
  const [changing, setChanging] = useState(false)
  const valid = isPerHour(draft.perHour) && isDays(draft.days)
  const choice: SpendingChoice = valid ? { perHour: draft.perHour, days: Number(draft.days) } : DEFAULT_CHOICE
  const run = useTurnOnSpending(me)
  const base = me.chains.find((chain) => chain.chain === 'base')
  const upgraded = base?.upgraded === true
  const items = spendingItems({
    upgraded,
    allowed: base?.allowance !== undefined,
    phase: run.phase,
    failed: run.error !== undefined,
  })
  const cap = hourlyCap(choice, me.limits)
  return (
    <section className="flex flex-col gap-8">
      <ScreenHeader step={step} total={total} title="Turn on spending" level={level}>
        {limitsSentence(choice, me.limits)} You can change these any time.{' '}
        {!run.running && (
          <button
            type="button"
            aria-expanded={changing}
            onClick={() => setChanging(!changing)}
            className="rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {changing ? 'Done' : 'Change'}
          </button>
        )}
      </ScreenHeader>
      {changing && !run.running && <ChangeLimits choice={draft} onChange={setDraft} />}
      {cap !== undefined && (
        <p className="text-sm text-muted-foreground text-pretty">
          Your wallet&apos;s own limit of {cap} an hour still applies. Change it on Limits.
        </p>
      )}
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium">{confirmationsText(upgraded)}</p>
        <Confirmations items={items} />
      </div>
      {run.error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{run.error} Nothing was spent. You can try again.</AlertDescription>
        </Alert>
      )}
      {run.confirming && (
        <Alert>
          <AlertDescription>
            Your upgrade was sent and is still confirming on Base. Try again in a minute to set your allowance.
          </AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        size="cta"
        className="w-full"
        disabled={!valid}
        pending={run.running}
        onClick={() => void run.start(choice)}
      >
        {run.error === undefined && !run.confirming ? 'Turn on spending' : 'Try again'}
      </Button>
      <HowItWorks />
    </section>
  )
}
