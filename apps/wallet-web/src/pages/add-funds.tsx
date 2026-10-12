// "Add funds": the owner's own address as a big QR code, for USDC sent on Base (the same address on every EVM chain),
// and, folded away, a one-off Relay deposit address for money that starts on another chain or in another token and
// should land in the owner's account on Base. Its own page in the console, and the first step of setup.
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@goblin/ui'
import type { DepositAddress, DepositRequest } from '@goblin/wallet/contract'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useDeposit, useDepositStatus, useMe, useReturnCheck, useStatus } from '../api/queries.tsx'
import { useLocation } from '../app/router.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { CHAIN_LABEL, formatToken, formatUsd, formatUsdCompact, shortAddress } from '../ui/format.ts'
import { cn, CopyButton } from '../ui/index.ts'
import { Page } from '../ui/page.tsx'
import { QrCode } from '../ui/qr-code.tsx'
import { usdOf } from '../views/money.ts'
import { returnParam } from './setup/return.ts'
import {
  aboutSeconds,
  amountProblem,
  DEPOSIT_ASSETS,
  DEPOSIT_CHAINS,
  type DepositPhase,
  depositPhase,
  groupAddress,
  isSettled,
  needsNoDeposit,
  ownerOnBase,
} from './deposit-model.ts'
import { ActionError } from './setup-actions.tsx'

/** The owner's address to send to: a QR code a phone wallet scans, the address in groups of four, and Copy. */
export function ReceiveAddress({ owner }: { readonly owner: string }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <QrCode value={owner} label={`QR code of your address ${owner}`} className="size-48 rounded-xl p-2" />
      <p className="max-w-60 text-center font-mono text-sm/relaxed text-pretty">{groupAddress(owner)}</p>
      <CopyButton text={owner} label="Copy your address" />
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
        <div className="grid grid-cols-2 gap-4">
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
        </div>
        <div className="grid grid-cols-2 gap-4">
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
          variant="secondary"
          size="cta"
          disabled={problem !== undefined || direct}
          pending={deposit.isPending}
        >
          Get a deposit address
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
      <p className="text-base font-medium text-balance">
        Send exactly {formatToken(quote.amount)} {quote.asset} on {CHAIN_LABEL[quote.from]} to
      </p>
      <div className="flex flex-col items-center gap-3">
        <QrCode
          value={quote.depositAddress}
          label={`QR code of the deposit address ${quote.depositAddress}`}
          className="size-40 rounded-xl p-2"
        />
        <p className="max-w-60 text-center font-mono text-sm/relaxed">{groupAddress(quote.depositAddress)}</p>
        <CopyButton text={quote.depositAddress} label="Copy the deposit address" />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">You receive about</dt>
        <dd className="text-end tabular-nums">
          {formatToken(quote.expectedOut)} {quote.receive} on Base
        </dd>
        <dt className="text-muted-foreground">Fees</dt>
        <dd className="text-end tabular-nums">{formatUsd(quote.feesUsd)}</dd>
        <dt className="text-muted-foreground">Takes</dt>
        <dd className="text-end">{aboutSeconds(quote.timeEstimateSeconds)}</dd>
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
      <Button type="button" variant={settled ? 'secondary' : 'ghost'} className="self-start" onClick={onReset}>
        {settled ? 'Add more' : 'Use a different amount'}
      </Button>
    </div>
  )
}

/** A Relay deposit from another chain or token, folded away until the owner asks for it. */
export function FromElsewhere() {
  const status = useStatus()
  const [deposit, setDeposit] = useState<{ readonly quote: DepositAddress; readonly before: bigint | undefined }>()
  return (
    <Collapsible className="flex flex-col">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="group/fold self-center" />}>
        From another chain or token
        <ChevronDown
          data-icon="inline-end"
          aria-hidden
          className="group-data-panel-open/fold:rotate-180 motion-safe:transition-transform"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 pt-4">
          <p className="text-sm/relaxed text-muted-foreground text-pretty">
            ETH, or USDC on Arbitrum or Ethereum? Get a one-off deposit address, and it arrives here as USDC on Base.
          </p>
          {deposit === undefined ? (
            <DepositForm onQuote={(quote) => setDeposit({ quote, before: ownerOnBase(status.data, quote.receive) })} />
          ) : (
            <DepositProgress quote={deposit.quote} before={deposit.before} onReset={() => setDeposit(undefined)} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** What the owner holds on Base now, read every few seconds while this page is open. */
function HeldOnBase() {
  const status = useStatus(10_000)
  const units = ownerOnBase(status.data, 'USDC')
  if (status.isPending) return null
  return (
    <p role="status" className="text-center text-sm text-muted-foreground tabular-nums">
      {units === undefined
        ? 'Your balance on Base could not be read just now.'
        : `You have ${formatUsdCompact(usdOf(units))} USDC on Base.`}
    </p>
  )
}

/** `/add-funds`: the owner's address and what they hold on Base, then a deposit from another chain or token. */
/**
 * A client that sent the owner here to top up (`/add-funds?return=<url>`) gets a way back, once the Worker vouches the
 * URL is on one of the owner's own clients, as `/setup` does.
 */
function BackToClient({ url }: { readonly url: string }) {
  const checked = useReturnCheck(url)
  const { url: href, host } = checked.data ?? {}
  if (href === undefined || host === undefined) return null
  return (
    <Button nativeButton={false} size="cta" variant="outline" className="w-full" render={<a href={href} />}>
      Back to {host}
    </Button>
  )
}

export function AddFundsPage() {
  const me = useMe()
  const back = returnParam(useLocation().search)
  return (
    <Page title="Add funds" description="Send USDC on Base to your address. It is the same address on every EVM chain.">
      <Async query={me}>
        {(data) => (
          <div className="flex w-full max-w-md flex-col gap-6">
            <ReceiveAddress owner={data.owner} />
            <HeldOnBase />
            <FromElsewhere />
            {back !== undefined && <BackToClient url={back} />}
          </div>
        )}
      </Async>
    </Page>
  )
}
