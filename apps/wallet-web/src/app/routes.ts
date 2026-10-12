// Which page a path is. The console's pages sit inside the Shell and its navigation; setup, consent, approvals and a
// merchant's subscription (`/subscribe/:id`, ADR 0054) are pages the owner lands on from outside, one task each,
// without it. Any other path is Home.
import { normalizePath } from './router.tsx'

/** A page inside the console's Shell. */
export type ConsolePageName = 'home' | 'activity' | 'limits' | 'connections' | 'add-funds'

export type Route =
  | { readonly page: ConsolePageName }
  | { readonly page: 'setup' | 'consent' }
  | { readonly page: 'approve'; readonly operationId: string }
  | { readonly page: 'subscribe'; readonly subscriptionId: string }

const SHELL_PAGES = ['activity', 'limits', 'connections', 'add-funds'] as const
const FOCUS_PAGES = ['setup', 'consent'] as const

/** A path segment decoded, or as it came when its escapes are broken. */
const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    // expected: a hand-edited link with a stray `%`; the page then says the operation is unknown
    return segment
  }
}

export function routeOf(path: string): Route {
  const pathname = normalizePath(path)
  if (pathname.startsWith('/approve/')) {
    const operationId = decoded(pathname.slice('/approve/'.length))
    if (operationId !== '') return { page: 'approve', operationId }
  }
  if (pathname.startsWith('/subscribe/')) {
    const subscriptionId = decoded(pathname.slice('/subscribe/'.length))
    if (subscriptionId !== '') return { page: 'subscribe', subscriptionId }
  }
  const name = pathname.slice(1)
  const shell = SHELL_PAGES.find((page) => page === name)
  if (shell !== undefined) return { page: shell }
  const focus = FOCUS_PAGES.find((page) => page === name)
  return focus === undefined ? { page: 'home' } : { page: focus }
}
