import { Button } from '@goblin/ui'
import type { Operation, OperationCheck } from '@goblin/wallet/contract'
import { useState } from 'react'

/**
 * Check status for an operation whose outcome is unknown: it asks the chain how the payment ended and says what it
 * found in one sentence beside the button. It never pays.
 */
export function CheckStatus({
  operation,
  onCheck,
}: {
  readonly operation: Operation
  readonly onCheck: (operation: Operation) => Promise<OperationCheck>
}) {
  const [state, setState] = useState<
    { readonly kind: 'idle' } | { readonly kind: 'checking' } | { readonly kind: 'done'; readonly note: string }
  >({ kind: 'idle' })
  async function check(): Promise<void> {
    setState({ kind: 'checking' })
    try {
      setState({ kind: 'done', note: (await onCheck(operation)).note })
    } catch (failure) {
      // expected: a refused or failed check changes nothing; the owner reads why and can try again
      setState({
        kind: 'done',
        note: failure instanceof Error && failure.message !== '' ? failure.message : 'The check did not answer.',
      })
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        pending={state.kind === 'checking'}
        onClick={() => void check()}
      >
        Check status
      </Button>
      {state.kind === 'done' && (
        <span role="status" className="max-w-prose text-xs/relaxed text-pretty">
          {state.note}
        </span>
      )}
    </span>
  )
}
