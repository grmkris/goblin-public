import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { makeQueryClient } from './lib/query/api-query.ts'
import { routeTree } from './routeTree.gen'

/**
 * One router, and one QueryClient with it, per call: on the server per request, never shared through module state
 * (myapps ADR 0013). An owner request that finds the session gone clears the cache and goes to sign-in.
 */
export function getRouter() {
  const queryClient = makeQueryClient({
    onUnauthenticated: () => {
      queryClient.clear()
      void router.navigate({ to: '/login' })
    },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  })
  return router
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
