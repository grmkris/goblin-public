// "Add funds": the owner's own address for sends on any EVM chain, and a one-off Relay deposit address for money that
// starts on another chain or in another token and should land in the owner's account on Base. On Home, and as the
// first funding step of onboarding.
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Separator,
} from '@goblin/ui'
import type { DepositAddress, DepositRequest } from '@goblin/wallet/contract'
import { useState } from 'react'
import { useDeposit, useDepositStatus, useStatus } from '../api/queries.tsx'
import { errorText } from '../ui/async.tsx'
import { CHAIN_LABEL, formatToken, formatUsd, shortAddress } from '../ui/format.ts'
import { cn, CopyButton } from '../ui/index.ts'
import {
  aboutSeconds,
  amountProblem,
  DEPOSIT_ASSETS,
  DEPOSIT_CHAINS,
  type DepositPhase,
  depositPhase,
  isSettled,
  needsNoDeposit,
  ownerOnBase,
} from './deposit-model.ts'
import { ActionError } from './setup-actions.tsx'

function YourAddress({ owner }: { readonly owner: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Your address</h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <code className="min-w-0 font-mono text-sm break-all">{owner}</code>
        <CopyButton text={owner} label="Copy your address" />
      </div>
      <p className="max-w-prose text-sm/relaxed text-muted-foreground text-pretty">
        Send USDC (or ETH) on Base, Arbitrum or Ethereum to this address. It is the same address on every EVM chain.
        Sent on Base, it works right away.
      </p>
    </div>
  )
}

function Choice<T extends string>({
  id,
  label,
  value,
  options,
  name,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly value: T
  readonly options: readonly T[]
  readonly name: (option: T) => string
  readonly onChange: (value: T) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        className="w-full"
        onChange={(event) => {
          const picked = options.find((option) => option === event.target.value)
          if (picked !== undefined) onChange(picked)
        }}
      >
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {name(option)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  )
}

const same = (value: string): string => value

function AmountField({
  asset,
  value,
  problem,
  onChange,
}: {
  readonly asset: DepositRequest['asset']
  readonly value: string
  readonly problem: string | undefined
  readonly onChange: (value: string) => void
}) {
  const invalid = problem !== undefined && value !== '' ? true : undefined
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor="deposit-amount">Amount of {asset}</FieldLabel>
      <Input
        id="deposit-amount"
        inputMode="decimal"
        autoComplete="off"
        placeholder={asset === 'ETH' ? '0.01' : '25'}
        value={value}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value.trim())}
      />
      {invalid && <FieldError>{problem}</FieldError>}
    </Field>
  )
}

function DepositForm({ onQuote }: { readonly onQuote: (quote: DepositAddress) => void }) {
  const [from, setFrom] = useState<DepositRequest['from']>('arbitrum')
  const [asset, setAsset] = useState<DepositRequest['asset']>('USDC')
  const [amount, setAmount] = useState('')
  const [receive, setReceive] = useState<DepositRequest['receive']>('USDC')
  const deposit = useDeposit()
  const problem = amountProblem(amount, asset)
  const direct = needsNoDeposit({ from, asset, receive })
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (problem === undefined && !direct) deposit.mutate({ from, asset, amount, receive }, { onSuccess: onQuote })
      }}
    >
      <FieldGroup>
        <div className="grid gap-4 @md/field-group:grid-cols-2">
          <Choice
            id="deposit-from"
            label="From"
            value={from}
            options={DEPOSIT_CHAINS}
            name={(chain) => CHAIN_LABEL[chain]}
            onChange={setFrom}
          />
          <Choice
            id="deposit-asset"
            label="Send"
            value={asset}
            options={DEPOSIT_ASSETS}
            name={same}
            onChange={setAsset}
          />
          <AmountField asset={asset} value={amount} problem={problem} onChange={setAmount} />
          <Choice
            id="deposit-receive"
            label="Receive on Base"
            value={receive}
            options={DEPOSIT_ASSETS}
            name={same}
            onChange={setReceive}
          />
        </div>
        {direct && (
          <FieldDescription>
            On Base, send {asset} straight to your address above. No deposit address is needed.
          </FieldDescription>
        )}
        <ActionError message={deposit.isError ? errorText(deposit.error) : undefined} />
        <Button
          type="submit"
          className="self-start"
          disabled={problem !== undefined || direct}
          pending={deposit.isPending}
        >
          Get deposit address
        </Button>
      </FieldGroup>
    </form>
  )
}

const PHASE: Record<DepositPhase, { readonly text: string; readonly dot: string }> = {
  waiting: { text: 'Waiting for your deposit. This checks every few seconds.', dot: 'bg-muted-foreground/50' },
  unknown: {
    text: "Relay isn't reporting right now. Your balance will show the deposit when it lands.",
    dot: 'bg-muted-foreground/50',
  },
  pending: { text: 'Deposit seen. Sending it to your account on Base.', dot: 'bg-live' },
  arrived: { text: 'Arrived in your account on Base.', dot: 'bg-success' },
  refunded: { text: 'Relay refunded this deposit to the address it came from.', dot: 'bg-attention' },
  failed: {
    text: 'Relay reports this deposit failed. Check its transactions before you send again.',
    dot: 'bg-destructive',
  },
}

function DepositProgress({
  quote,
  before,
  onReset,
}: {
  readonly quote: DepositAddress
  /** The owner's balance on Base of what they receive, when the address was made. */
  readonly before: bigint | undefined
  readonly onReset: () => void
}) {
  const status = useStatus()
  const now = ownerOnBase(status.data, quote.receive)
  const landed = before !== undefined && now !== undefined && now > before
  const relay = useDepositStatus(quote.depositAddress, !landed)
  const phase = depositPhase({ relay: relay.data?.status, before, now })
  const settled = isSettled(phase)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base font-medium">
        Send exactly {formatToken(quote.amount)} {quote.asset} on {CHAIN_LABEL[quote.from]}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-3 py-2">
        <code className="min-w-0 font-mono text-sm break-all">{quote.depositAddress}</code>
        <CopyButton text={quote.depositAddress} label="Copy the deposit address" />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">You receive about</dt>
        <dd className="tabular-nums">
          {formatToken(quote.expectedOut)} {quote.receive} on Base
        </dd>
        <dt className="text-muted-foreground">Fees</dt>
        <dd className="tabular-nums">{formatUsd(quote.feesUsd)}</dd>
        <dt className="text-muted-foreground">Takes</dt>
        <dd>{aboutSeconds(quote.timeEstimateSeconds)}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">This address is for this deposit only.</p>
      <p role="status" className="flex items-baseline gap-2 text-sm">
        <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', PHASE[phase].dot)} />
        {PHASE[phase].text}
      </p>
      {(relay.data?.txHashes.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {relay.data?.txHashes.map((hash) => (
            <li key={hash} className="flex items-center gap-1 text-muted-foreground tabular-nums">
              Transaction {shortAddress(hash)}
              <CopyButton text={hash} label={`Copy transaction ${shortAddress(hash)}`} compact />
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant={settled ? 'default' : 'ghost'} className="self-start" onClick={onReset}>
        {settled ? 'Add more' : 'Use a different amount'}
      </Button>
    </div>
  )
}

/** The card: the owner's address, then a deposit address from another chain or token, landing USDC on Base unless picked otherwise. */
export function AddFundsCard({ owner }: { readonly owner: string }) {
  const status = useStatus()
  const [deposit, setDeposit] = useState<{ readonly quote: DepositAddress; readonly before: bigint | undefined }>()
  return (
    <div className="flex flex-col gap-5 rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
      <YourAddress owner={owner} />
      <Separator />
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-medium">From another chain or token</h3>
        {deposit === undefined ? (
          <DepositForm onQuote={(quote) => setDeposit({ quote, before: ownerOnBase(status.data, quote.receive) })} />
        ) : (
          <DepositProgress quote={deposit.quote} before={deposit.before} onReset={() => setDeposit(undefined)} />
        )}
      </div>
    </div>
  )
}
