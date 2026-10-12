// "Pays from": the agent's own address on Tempo, which paid inference and MPP services pay from, with copy and a QR
// code, and Add funds from any chain right here in the App (a one-off Relay deposit address through `add_funds`). An
// empty wallet opens on it as "Fund this address"; so does a host that opened the App with focus `add_funds`.
import { Button, Field, FieldError, FieldGroup, FieldLabel, Input, NativeSelect, NativeSelectOption } from '@goblin/ui'
import type { DepositAddress, DepositRequest, DepositStatus, PayFrom } from '@goblin/wallet/contract'
import { useEffect, useState } from 'react'
import {
  aboutSeconds,
  amountProblem,
  DEPOSIT_ASSETS,
  DEPOSIT_CHAINS,
  type DepositPhase,
  depositPhase,
  isSettled,
} from '../pages/deposit-model.ts'
import { CHAIN_LABEL, formatToken, formatUsd } from '../ui/format.ts'
import { cn, CopyButton } from '../ui/index.ts'
import { QrCode } from '../ui/qr-code.tsx'

/** What the card asks of the host: a deposit address, its progress, and a fresh status to see the balance rise. */
export interface FundActions {
  readonly quote: (request: DepositRequest) => Promise<DepositAddress>
  readonly progress: (depositAddress: string) => Promise<DepositStatus>
  readonly refresh: () => void
}

/** How often a deposit in flight is followed: Relay's progress and the balance. */
const FOLLOW_MS = 6000

function Choice<T extends string>(props: {
  readonly id: string
  readonly label: string
  readonly value: T
  readonly options: readonly T[]
  readonly name: (option: T) => string
  readonly onChange: (value: T) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <NativeSelect
        id={props.id}
        value={props.value}
        className="w-full"
        onChange={(event) => {
          const picked = props.options.find((option) => option === event.target.value)
          if (picked !== undefined) props.onChange(picked)
        }}
      >
        {props.options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {props.name(option)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  )
}

const same = (value: string): string => value

function DepositForm({
  quote,
  onQuote,
}: {
  readonly quote: FundActions['quote']
  readonly onQuote: (deposit: DepositAddress) => void
}) {
  const [from, setFrom] = useState<DepositRequest['from']>('base')
  const [asset, setAsset] = useState<DepositRequest['asset']>('USDC')
  const [amount, setAmount] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const problem = amountProblem(amount, asset)
  const invalid = problem !== undefined && amount !== '' ? true : undefined
  function submit() {
    setPending(true)
    setError(undefined)
    quote({ from, asset, amount, receive: 'USDC.e' }).then(
      (deposit) => {
        setPending(false)
        onQuote(deposit)
      },
      (failure: unknown) => {
        // expected: Relay or the wallet refused the quote; its words show under the form
        setPending(false)
        setError(failure instanceof Error ? failure.message : 'No deposit address just now. Try again.')
      },
    )
  }
  return (
    // Not a <form>: an App's sandboxed frame may not submit forms (no `allow-forms`), so the submit event never fires.
    // The button and Enter in the amount ask for the address themselves.
    <div role="group" aria-label="Add funds from any chain">
      <FieldGroup>
        <div className="grid gap-4 @md/field-group:grid-cols-3">
          <Choice
            id="fund-from"
            label="From"
            value={from}
            options={DEPOSIT_CHAINS}
            name={(chain) => CHAIN_LABEL[chain]}
            onChange={setFrom}
          />
          <Choice id="fund-asset" label="Send" value={asset} options={DEPOSIT_ASSETS} name={same} onChange={setAsset} />
          <Field data-invalid={invalid}>
            <FieldLabel htmlFor="fund-amount">Amount of {asset}</FieldLabel>
            <Input
              id="fund-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder={asset === 'ETH' ? '0.002' : '5'}
              value={amount}
              aria-invalid={invalid}
              onChange={(event) => setAmount(event.target.value.trim())}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && problem === undefined && !pending) submit()
              }}
            />
            {invalid && <FieldError>{problem}</FieldError>}
          </Field>
        </div>
        {error !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          type="button"
          className="self-start"
          disabled={problem !== undefined}
          pending={pending}
          onClick={submit}
        >
          Get deposit address
        </Button>
      </FieldGroup>
    </div>
  )
}

const PHASE: Record<DepositPhase, { readonly text: string; readonly dot: string }> = {
  waiting: { text: 'Waiting for your deposit. This checks every few seconds.', dot: 'bg-muted-foreground/50' },
  unknown: {
    text: "Relay isn't reporting right now. The balance above shows the deposit when it lands.",
    dot: 'bg-muted-foreground/50',
  },
  pending: { text: 'Deposit seen. Relay is delivering USDC.e to your agent on Tempo.', dot: 'bg-live' },
  arrived: { text: 'Arrived. Your agent pays from it now.', dot: 'bg-success' },
  refunded: { text: 'Relay refunded this deposit to the address it came from.', dot: 'bg-attention' },
  failed: {
    text: 'Relay reports this deposit failed. Check its transactions before you send again.',
    dot: 'bg-destructive',
  },
}

/**
 * Where a deposit stands, following it until it settles: Relay's word, and a fresh status each time so the agent's
 * balance can show the arrival when Relay says nothing.
 */
function useDepositPhase(
  deposit: DepositAddress,
  actions: FundActions,
  before: bigint | undefined,
  held: bigint | undefined,
): DepositPhase {
  const [relay, setRelay] = useState<DepositStatus['status']>()
  const phase = depositPhase({ relay, before, now: held })
  const settled = isSettled(phase)
  const { progress, refresh } = actions
  useEffect(() => {
    if (settled) return undefined
    const timer = setInterval(() => {
      // expected: a missed answer is just a later one; Relay's silence never fails the deposit
      progress(deposit.depositAddress).then(
        (answer) => setRelay(answer.status),
        () => setRelay('unknown'),
      )
      refresh()
    }, FOLLOW_MS)
    return () => clearInterval(timer)
  }, [deposit.depositAddress, progress, refresh, settled])
  return phase
}

function DepositProgress({
  deposit,
  before,
  held,
  actions,
  onReset,
}: {
  readonly deposit: DepositAddress
  /** The agent's USDC.e on Tempo when the address was made, and now. */
  readonly before: bigint | undefined
  readonly held: bigint | undefined
  readonly actions: FundActions
  readonly onReset: () => void
}) {
  const phase = useDepositPhase(deposit, actions, before, held)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base font-medium">
        Send exactly {formatToken(deposit.amount)} {deposit.asset} on {CHAIN_LABEL[deposit.from]}
      </p>
      <div className="flex flex-wrap items-start gap-4">
        <QrCode value={deposit.depositAddress} label={`QR code of the deposit address ${deposit.depositAddress}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-3 py-2">
            <code className="min-w-0 font-mono text-sm break-all">{deposit.depositAddress}</code>
            <CopyButton text={deposit.depositAddress} label="Copy the deposit address" />
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Your agent receives about</dt>
            <dd className="tabular-nums">{formatToken(deposit.expectedOut)} USDC.e on Tempo</dd>
            <dt className="text-muted-foreground">Fees</dt>
            <dd className="tabular-nums">{formatUsd(deposit.feesUsd)}</dd>
            <dt className="text-muted-foreground">Takes</dt>
            <dd>{aboutSeconds(deposit.timeEstimateSeconds)}</dd>
          </dl>
          <p className="text-sm text-muted-foreground">This address is for this deposit only.</p>
        </div>
      </div>
      <p role="status" className="flex items-baseline gap-2 text-sm">
        <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', PHASE[phase].dot)} />
        {PHASE[phase].text}
      </p>
      <Button type="button" variant={isSettled(phase) ? 'default' : 'ghost'} className="self-start" onClick={onReset}>
        {isSettled(phase) ? 'Add more' : 'Use a different amount'}
      </Button>
    </div>
  )
}

function AddFundsPanel({ held, actions }: { readonly held: bigint | undefined; readonly actions: FundActions }) {
  const [deposit, setDeposit] = useState<{ readonly address: DepositAddress; readonly before: bigint | undefined }>()
  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      <h3 className="text-sm font-medium">Add funds from any chain</h3>
      {deposit === undefined ? (
        <DepositForm quote={actions.quote} onQuote={(address) => setDeposit({ address, before: held })} />
      ) : (
        <DepositProgress
          deposit={deposit.address}
          before={deposit.before}
          held={held}
          actions={actions}
          onReset={() => setDeposit(undefined)}
        />
      )}
    </div>
  )
}

/** "Holds 4.74 USDC.e", or that Tempo could not be read just now. */
const heldText = (payFrom: PayFrom): string =>
  payFrom.held === undefined ? 'balance not read just now' : `holds ${formatToken(payFrom.held)} USDC.e`

export function PaysFrom({
  payFrom,
  empty,
  open,
  held,
  actions,
  onOpen,
}: {
  readonly payFrom: PayFrom
  /** Nothing is held anywhere yet: the card asks to fund this address. */
  readonly empty: boolean
  readonly open: boolean
  readonly held: bigint | undefined
  readonly actions: FundActions
  readonly onOpen: () => void
}) {
  return (
    <section
      aria-label="Where your agent pays from"
      className="flex flex-col gap-4 rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h2 className={cn('text-sm', empty ? 'font-medium' : 'text-muted-foreground')}>
            {empty ? 'Fund this address' : 'Your agent pays from'}
          </h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <code className="min-w-0 font-mono text-sm break-all">{payFrom.address}</code>
            <CopyButton text={payFrom.address} label="Copy your agent's address" />
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">Tempo · USDC.e · {heldText(payFrom)}</p>
          <p className="max-w-prose text-sm/relaxed text-muted-foreground text-pretty">
            Paid model calls and services are paid from here. Send USDC.e on Tempo to this address, or add funds from
            Base, Arbitrum or Ethereum.
          </p>
        </div>
        <QrCode
          value={payFrom.address}
          label={`QR code of your agent's address ${payFrom.address}`}
          className="size-28"
        />
      </div>
      {open ? (
        <AddFundsPanel held={held} actions={actions} />
      ) : (
        <Button type="button" variant={empty ? 'default' : 'outline'} className="self-start" onClick={onOpen}>
          Add funds from any chain
        </Button>
      )}
    </section>
  )
}
