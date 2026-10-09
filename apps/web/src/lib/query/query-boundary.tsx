import { Alert, AlertDescription, Button } from '@goblin/ui'
import { QueryErrorResetBoundary, useQueryErrorResetBoundary } from '@tanstack/react-query'
import { CatchBoundary, type ErrorComponentProps } from '@tanstack/react-router'
import { Suspense, useCallback, type ReactNode } from 'react'
import { messageOf } from './app-error.ts'

export interface QueryBoundaryProps {
  readonly children: ReactNode
  /** What shows while a read inside suspends. */
  readonly pending?: ReactNode
  /** What the section does, for its failure's copy ("Could not ‹action›. … · ref 7f3a9c12"). */
  readonly action: string
}

/**
 * A section that reads with `useSuspenseQuery`: it waits with `pending`, and a failed read stays inline with the
 * reference to quote and a retry, without replacing the whole page. Other sections stay usable.
 */
export function QueryBoundary({ children, pending = null, action }: QueryBoundaryProps) {
  const ErrorComponent = useCallback(
    ({ error, reset }: ErrorComponentProps) => <InlineError error={error} reset={reset} action={action} />,
    [action],
  )
  return (
    <QueryErrorResetBoundary>
      <CatchBoundary getResetKey={() => action} errorComponent={ErrorComponent}>
        <Suspense fallback={pending}>{children}</Suspense>
      </CatchBoundary>
    </QueryErrorResetBoundary>
  )
}

function InlineError({ error, reset, action }: ErrorComponentProps & { readonly action: string }) {
  const query = useQueryErrorResetBoundary()
  return (
    <QueryError
      error={error}
      action={action}
      onRetry={() => {
        query.reset()
        reset()
      }}
    />
  )
}

/**
 * A failed read shown in place: its copy with the reference to quote, and a retry. `QueryBoundary` shows it for a
 * suspended read; a section that reads with `useQuery` shows it for `query.error` with `onRetry={() => query.refetch()}`.
 */
export function QueryError({
  error,
  action,
  onRetry,
}: {
  readonly error: unknown
  readonly action: string
  readonly onRetry: () => void
}) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{messageOf(error, action)}</AlertDescription>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  )
}
