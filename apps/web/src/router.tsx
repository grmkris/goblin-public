import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { makeQueryClient } from './lib/query/api-query.ts'
import { ReportedRouteError } from './lib/query/route-error.tsx'
import { reportUnexpected } from './lib/unexpected.ts'
import { routeTree } from './routeTree.gen'

/**
 * One router, and one QueryClient with it, per call: on the server per request, never shared through module state
 * (myapps ADR 0013). An owner request that finds the session gone clears the cache and goes to sign-in. A route that
 * fails shows the calm error view with its reference, and a defect is reported as a crash.
 */
export function getRouter() {
  const queryClient = makeQueryClient({
    onUnauthenticated: () => {
      queryClient.clear()
      router.navigate({ to: '/login' }).catch(reportUnexpected)
    },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ReportedRouteError,
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  })
  return router
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
  interface StaticDataRouteOption {
    /** The page waits for first-run Start (ADR 0048): the shell sends an owner who has not been through it there. */
    readonly startRequired?: boolean
  }
}
