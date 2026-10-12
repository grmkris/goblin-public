// The pieces every setup action shares, in onboarding and on Home: one signing action's pending and error state, the
// line that says what failed, and the USDC-per-hour input an allowance starts from.
import { Alert, AlertDescription, Field, FieldDescription, FieldError, FieldLabel, Input } from '@goblin/ui'
import { usdToMicros } from '@goblin/wallet/amounts'
import { useState } from 'react'
import { errorText } from '../ui/async.tsx'
import { formatUsd } from '../ui/index.ts'

const USD = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/u

/** What an allowance starts at before the owner changes it, in USDC per hour. */
export const DEFAULT_PER_HOUR = '20'

/** A positive USDC amount with at most six decimals: what `AllowancePrepare.perHour` takes. */
export const isPerHour = (value: string): boolean => USD.test(value) && usdToMicros(value) > 0n

/** One signing action: pending while it runs, the server's or the wallet's sentence when it fails. */
export function useAction(run: () => Promise<unknown>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const start = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      await run()
    } catch (caught) {
      // expected: wallet prompts get refused, networks drop; the sentence says what to do
      setError(errorText(caught))
    } finally {
      setPending(false)
    }
  }
  return { pending, error, start }
}

export function ActionError({ message }: { readonly message: string | undefined }) {
  if (message === undefined) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{message} Nothing was spent. You can try again.</AlertDescription>
    </Alert>
  )
}

/** The USDC-per-hour input, with what the amount means on `chainName` or how to fix it. */
export function PerHourField({
  id,
  value,
  chainName,
  onChange,
}: {
  readonly id: string
  readonly value: string
  readonly chainName: string
  readonly onChange: (value: string) => void
}) {
  const valid = isPerHour(value)
  const invalid = !valid && value !== '' ? true : undefined
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>USDC per hour</FieldLabel>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-40"
      />
      {valid ? (
        <FieldDescription>
          Your agent can spend at most {formatUsd(value)} an hour on {chainName}.
        </FieldDescription>
      ) : (
        <FieldError>Enter an amount like 5 or 0.50.</FieldError>
      )}
    </Field>
  )
}
