import { Button, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@goblin/ui'
import { useQueryErrorResetBoundary } from '@tanstack/react-query'
import { type ErrorComponentProps, useRouter, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'
import { messageOf } from './app-error.ts'

/** Resets Query's error boundary, then reloads the route's data. */
export function useRouteErrorRetry(router: { invalidate: () => Promise<void> }) {
  const { reset } = useQueryErrorResetBoundary()
  return useCallback(async () => {
    reset()
    await router.invalidate()
  }, [reset, router])
}

/** A route that crashed, as reported beyond the screen: which route, and the error itself (never rendered as text). */
export interface CrashReport {
  readonly routeId: string
  readonly error: unknown
}
/** Where crash reports go; `/api/client-errors` plugs in here. */
export type CrashReporter = (report: CrashReport) => void

/**
 * A route that failed to load or render: the calm copy for its failure with the reference to quote ("… · ref
 * 7f3a9c12"), and a retry. `onCrash` hears each failure once.
 */
export function RouteError({ error, onCrash }: ErrorComponentProps & { readonly onCrash?: CrashReporter | undefined }) {
  const router = useRouter()
  const retry = useRouteErrorRetry(router)
  const routeId = useRouterState({ select: (state) => state.matches.at(-1)?.routeId ?? '__root__' })
  useEffect(() => {
    onCrash?.({ routeId, error })
  }, [onCrash, routeId, error])
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This page did not load</EmptyTitle>
        <EmptyDescription>{messageOf(error, 'load this page')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={() => void retry()}>Try again</Button>
      </EmptyContent>
    </Empty>
  )
}
