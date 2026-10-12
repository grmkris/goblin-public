import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from '@goblin/ui'
import type { Recipient, ServiceRule, WalletLimits } from '@goblin/wallet/contract'
import { useState } from 'react'
import { useAddressBook, useLimits, useMe, useServices, useSetLimits } from '../api/queries.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { AddressChip, Amount, ChainBadge, LAYERS, LimitMeter } from '../ui/index.ts'
import { EmptyState, Page, RowList, Section } from '../ui/page.tsx'
import { checkLimits, type LimitDraft } from './limit-draft.ts'

const FIELDS = [
  ['perCall', 'Per call', 'The most one payment can be.'],
  ['perHour', 'Per hour', 'The most in any hour.'],
  ['perWeek', 'Per week', 'The most in any week.'],
] as const

const GRANT = [
  ['keep', 'Keep the current end date'],
  ['1', '1 day from now'],
  ['7', '7 days from now'],
  ['30', '30 days from now'],
] as const

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
        className="max-w-40"
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
      <NativeSelect
        id="limit-grant"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-64"
      >
        {GRANT.map(([option, label]) => (
          <NativeSelectOption key={option} value={option}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>
        Currently until {new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}.
      </FieldDescription>
    </Field>
  )
}

function LedgerForm({ current }: { readonly current: WalletLimits }) {
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
    save.mutate({ ...draft, expiresAt, version: current.version })
  }
  return (
    <Card>
      <CardContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (problems.length === 0) submit()
          }}
        >
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
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!dirty || problems.length > 0 || save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              Save limits
            </Button>
            {save.isSuccess && !dirty && (
              <span role="status" className="text-sm text-muted-foreground">
                Saved.
              </span>
            )}
          </div>
          <p className="text-xs/relaxed text-muted-foreground">
            {LAYERS.ledger.name}: {LAYERS.ledger.promise} The on-chain allowance above only changes when you sign a new
            one.
          </p>
        </form>
      </CardContent>
    </Card>
  )
}

function ServiceRow({ service }: { readonly service: ServiceRule }) {
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{service.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {service.method} {service.url.replace('https://', '')}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          {service.chains.map((chain) => (
            <ChainBadge key={chain} chain={chain} />
          ))}
          <span>{service.rails.join(', ')}</span>
        </span>
      </div>
      <Amount usd={service.maxPerCall} size="sm" align="end" className="shrink-0" />
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

export function LimitsPage() {
  const me = useMe()
  const limits = useLimits()
  const services = useServices()
  const book = useAddressBook()
  return (
    <Page title="Limits" description="What your agent may spend, which layer enforces each limit, and who it may pay.">
      <Section title="In force now">
        <Async query={limits} rows={2}>
          {(rows) => (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-3">
              {rows.map((limit) => (
                <Card key={`${limit.layer}-${limit.period}-${limit.chain ?? ''}`}>
                  <CardContent>
                    <LimitMeter limit={limit} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </Async>
      </Section>
      <Section title="Wallet ledger limits">
        <Async query={me} rows={2}>
          {(data) =>
            data.limits === undefined ? (
              <EmptyState title="No limits yet" description="Finish setting up your wallet to set them." />
            ) : (
              <LedgerForm key={data.limits.version} current={data.limits} />
            )
          }
        </Async>
      </Section>
      <Section title="Allowed services">
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
              <p className="text-xs text-muted-foreground">
                Your agent can pay only these, at most the amount shown per call. A new service asks you first.
              </p>
            </>
          )}
        </Async>
      </Section>
      <Section title="Address book">
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
      </Section>
    </Page>
  )
}
