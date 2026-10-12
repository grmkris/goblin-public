import { Alert, AlertDescription, AlertTitle, Button, Skeleton } from '@goblin/ui'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/** What a failed call tells the owner: the server's own words when it sent a recovery, otherwise a plain next step. */
export function errorText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong. Try again.'
}

export function LoadingBlock({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  )
}

export function ErrorBlock({ error, onRetry }: { readonly error: unknown; readonly onRetry?: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Could not load this</AlertTitle>
      <AlertDescription>
        <p>{errorText(error)}</p>
        {onRetry !== undefined && (
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

/** Loading, error and data in one place, so no page forgets a state. */
export function Async<T>({
  query,
  rows,
  children,
}: {
  readonly query: UseQueryResult<T>
  readonly rows?: number
  readonly children: (data: T) => ReactNode
}) {
  if (query.isPending) return <LoadingBlock {...(rows === undefined ? {} : { rows })} />
  if (query.isError) return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />
  return <>{children(query.data)}</>
}
