import {
  Alert,
  AlertDescription,
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
  Meter,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from '@goblin/ui'
import type { LimitView, Me, Recipient, ServiceRule, WalletLimits } from '@goblin/wallet/contract'
import { useState } from 'react'
import { useAddressBook, useLimits, useMe, useServices, useSetLimits } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { Fold } from '../ui/fold.tsx'
import { AddressChip, ChainBadge, cn, formatUsd, LAYERS, timeUntil } from '../ui/index.ts'
import { formatUsdCompact } from '../ui/format.ts'
import { EmptyState, Page, RowList } from '../ui/page.tsx'
import { limitOrder } from '../views/overview-model.ts'
import { LimitLine } from '../views/overview.tsx'
import { checkLimits, type LimitDraft } from './limit-draft.ts'
import { type Meter as LimitMeter, type MeterPeriod, metersOf } from './limits-model.ts'
import { OtherNetworks } from './other-networks.tsx'
import { PolicyRequests } from './policy-requests.tsx'
import { Subscriptions } from './subscriptions.tsx'

const FIELDS = [
  ['perCall', 'Per payment', 'The most one payment can be.'],
  ['perHour', 'Per hour', 'The most in any hour.'],
  ['perWeek', 'Per week', 'The most in any week.'],
] as const

const GRANT = [
  ['keep', 'Keep the current end date'],
  ['1', '1 day from now'],
  ['7', '7 days from now'],
  ['30', '30 days from now'],
] as const

const METER_TITLE: Record<MeterPeriod, string> = { call: 'Per payment', hour: 'Per hour', week: 'Per week' }

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** One limit as a meter: what is left of the period and of what, how much is used, and when it starts again. */
function MeterRow({ meter }: { readonly meter: LimitMeter }) {
  const { limit, left, used } = meter
  const nearly = used >= 90
  return (
    <div className="flex flex-col gap-2.5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{METER_TITLE[meter.period]}</span>
        {left === undefined ? (
          <span className="text-sm tabular-nums">
            <span className="text-muted-foreground">Up to </span>
            <span className="font-semibold">{formatUsd(limit.limit)}</span>
          </span>
        ) : (
          <span className="text-sm tabular-nums">
            <span className="font-semibold">{formatUsdCompact(left)}</span>
            <span className="text-muted-foreground"> left of {formatUsd(limit.limit)}</span>
          </span>
        )}
      </div>
      {left !== undefined && (
        <>
          <div className={cn(nearly && '[&_[data-slot=meter-indicator]]:bg-attention')}>
            <Meter
              value={used}
              min={0}
              max={100}
              aria-label={`${METER_TITLE[meter.period]}: ${formatUsd(limit.used ?? '0')} used`}
            />
          </div>
          <span className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
            <span>{formatUsd(limit.used ?? '0')} used</span>
            {limit.periodEndsAt !== undefined && <span>Resets {timeUntil(limit.periodEndsAt)}</span>}
          </span>
        </>
      )}
    </div>
  )
}

function LimitField({
  id,
  label,
  hint,
  value,
  problem,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly problem: string | undefined
  readonly onChange: (value: string) => void
}) {
  return (
    <Field data-invalid={problem === undefined ? undefined : true}>
      <FieldLabel htmlFor={`limit-${id}`}>{label} (USD)</FieldLabel>
      <Input
        id={`limit-${id}`}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-invalid={problem === undefined ? undefined : true}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem === undefined ? <FieldDescription>{hint}</FieldDescription> : <FieldError>{problem}</FieldError>}
    </Field>
  )
}

function GrantField({
  value,
  expiresAt,
  onChange,
}: {
  readonly value: string
  readonly expiresAt: string
  readonly onChange: (value: string) => void
}) {
  return (
    <Field>
      <FieldLabel htmlFor="limit-grant">Access lasts</FieldLabel>
      <NativeSelect id="limit-grant" value={value} onChange={(event) => onChange(event.target.value)}>
        {GRANT.map(([option, label]) => (
          <NativeSelectOption key={option} value={option}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>Currently until {shortDate(expiresAt)}.</FieldDescription>
    </Field>
  )
}

/** The owner's own limits, which this wallet checks before every payment; the on-chain allowance is left as signed. */
function LimitsForm({ current, onDone }: { readonly current: WalletLimits; readonly onDone: () => void }) {
  const save = useSetLimits()
  const [draft, setDraft] = useState<LimitDraft>({
    perCall: current.perCall,
    perHour: current.perHour,
    perWeek: current.perWeek,
  })
  const [grant, setGrant] = useState<string>('keep')
  const problems = checkLimits(draft)
  const dirty = FIELDS.some(([key]) => draft[key] !== current[key]) || grant !== 'keep'
  const submit = (): void => {
    const expiresAt =
      grant === 'keep' ? current.expiresAt : new Date(Date.now() + Number(grant) * 86_400_000).toISOString()
    save.mutate({ ...draft, expiresAt, version: current.version }, { onSuccess: onDone })
  }
  return (
    <form
      className="flex flex-col gap-5 pt-2 pb-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (problems.length === 0) submit()
      }}
    >
      <p className="text-sm/relaxed text-muted-foreground text-pretty">
        The wallet checks these before every payment. Your on-chain allowance stays as you signed it.
      </p>
      <FieldGroup>
        {FIELDS.map(([key, label, hint]) => (
          <LimitField
            key={key}
            id={key}
            label={label}
            hint={hint}
            value={draft[key]}
            problem={problems.find((entry) => entry.field === key)?.message}
            onChange={(value) => setDraft({ ...draft, [key]: value })}
          />
        ))}
        <GrantField value={grant} expiresAt={current.expiresAt} onChange={setGrant} />
      </FieldGroup>
      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(save.error)} Your limits are unchanged.</AlertDescription>
        </Alert>
      )}
      <Button type="submit" size="cta" disabled={!dirty || problems.length > 0 || save.isPending}>
        {save.isPending && <Spinner data-icon="inline-start" />}
        Save limits
      </Button>
    </form>
  )
}

/** What is in force now as three meters, when access ends, and Change limits opening the form in place. */
function InForce({ limits, me }: { readonly limits: readonly LimitView[]; readonly me: Me | undefined }) {
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const meters = metersOf(limits)
  const current = me?.limits
  return (
    <Collapsible open={editing} onOpenChange={setEditing}>
      <RowList>
        {meters.map((meter) => (
          <MeterRow key={meter.period} meter={meter} />
        ))}
        {meters.length === 0 && <p className="py-4 text-sm text-muted-foreground">No limits are set yet.</p>}
        {current !== undefined && (
          <div className="flex min-h-12 items-center justify-between gap-3 py-3 text-sm">
            <span className="text-muted-foreground">Access lasts until</span>
            <span className="tabular-nums">{shortDate(current.expiresAt)}</span>
          </div>
        )}
        {current !== undefined && (
          <CollapsibleContent>
            <LimitsForm
              key={current.version}
              current={current}
              onDone={() => {
                setEditing(false)
                setSaved(true)
              }}
            />
          </CollapsibleContent>
        )}
      </RowList>
      <div className="flex items-center gap-3 pt-3">
        {current === undefined ? (
          <p className="text-sm text-muted-foreground">
            Finish{' '}
            <Link to="/setup" className="text-foreground underline underline-offset-4">
              setting up your wallet
            </Link>{' '}
            to change these.
          </p>
        ) : (
          <CollapsibleTrigger render={<Button type="button" variant="secondary" size="cta" className="flex-1" />}>
            {editing ? 'Cancel' : 'Change limits'}
          </CollapsibleTrigger>
        )}
        {saved && !editing && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        )}
      </div>
    </Collapsible>
  )
}

/** Every limit from every layer, with who enforces it: the detail behind the three meters. */
function AllLimits({ limits }: { readonly limits: readonly LimitView[] }) {
  return (
    <>
      <RowList>
        {limits.toSorted(limitOrder).map((limit) => (
          <LimitLine key={`${limit.layer}-${limit.period}-${limit.chain ?? ''}`} limit={limit} showChain />
        ))}
      </RowList>
      <ul className="flex flex-col gap-1 px-1 text-xs/relaxed text-muted-foreground">
        {[...new Set(limits.map((limit) => limit.layer))].map((layer) => (
          <li key={layer}>
            <span className="text-foreground">{LAYERS[layer].name}:</span> {LAYERS[layer].promise}
          </li>
        ))}
      </ul>
    </>
  )
}

function ServiceRow({ service }: { readonly service: ServiceRule }) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium">{service.title}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="truncate">{new URL(service.url).host}</span>
          {service.chains.map((chain) => (
            <ChainBadge key={chain} chain={chain} />
          ))}
        </span>
      </span>
      <span className="shrink-0 text-sm tabular-nums">
        <span className="text-muted-foreground">up to </span>
        {formatUsd(service.maxPerCall)}
      </span>
    </li>
  )
}

function RecipientRow({ recipient }: { readonly recipient: Recipient }) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium">{recipient.label}</span>
        <ChainBadge chain={recipient.chain} />
      </span>
      <AddressChip address={recipient.address} chain={recipient.chain} />
    </li>
  )
}

function Services() {
  const services = useServices()
  return (
    <Fold title="Allowed services" summary={services.data?.length}>
      <Async query={services}>
        {(rows) => (
          <>
            <RowList>
              <ul className="divide-y divide-border">
                {rows.map((service) => (
                  <ServiceRow key={service.id} service={service} />
                ))}
              </ul>
            </RowList>
            <p className="px-1 text-xs text-muted-foreground text-pretty">
              Your agent can pay only these, up to the amount shown per payment. A new service asks you first.
            </p>
          </>
        )}
      </Async>
    </Fold>
  )
}

function AddressBook() {
  const book = useAddressBook()
  return (
    <Fold title="Address book" summary={book.data?.length}>
      <Async query={book}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState
              title="No saved recipients"
              description="The first payment to a new address asks you, and you can save it then."
            />
          ) : (
            <RowList>
              <ul className="divide-y divide-border">
                {rows.map((recipient) => (
                  <RecipientRow key={`${recipient.chain}-${recipient.address}`} recipient={recipient} />
                ))}
              </ul>
            </RowList>
          )
        }
      </Async>
    </Fold>
  )
}

export function LimitsPage() {
  const me = useMe()
  const limits = useLimits()
  return (
    <Page title="Limits">
      <Async query={limits} rows={3}>
        {(rows) => <InForce limits={rows} me={me.data} />}
      </Async>
      <Subscriptions />
      <div className="flex flex-col divide-y divide-border border-y border-border">
        <PolicyRequests />
        {limits.data !== undefined && limits.data.length > 0 && (
          <Fold title="Who checks each limit" summary={`${limits.data.length} limits`}>
            <AllLimits limits={limits.data} />
          </Fold>
        )}
        <Services />
        <AddressBook />
        <OtherNetworks />
      </div>
    </Page>
  )
}
