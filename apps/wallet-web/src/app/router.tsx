// A small history router: five owner pages and two deep links that goblin and the OAuth flow open.
import { type ComponentProps, type MouseEvent, type ReactNode, useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}
const snapshot = (): string => `${window.location.pathname}${window.location.search}`

export function navigate(to: string, options: { readonly replace?: boolean } = {}): void {
  if (options.replace === true) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  for (const listener of listeners) listener()
  window.scrollTo(0, 0)
}

/** The current location, split. Re-renders on navigation. */
export function useLocation(): { readonly pathname: string; readonly search: URLSearchParams } {
  const full = useSyncExternalStore(subscribe, snapshot, () => '/')
  const [pathname = '/', query = ''] = full.split('?')
  return { pathname, search: new URLSearchParams(query) }
}

/**
 * An in-app link. When a Button renders as one, the props it hands over (its own click handler among them) are kept,
 * and its handler runs before the navigation instead of replacing it: a replaced handler made every such link a full
 * page load.
 */
export function Link({
  to,
  children,
  onClick,
  ...rest
}: Omit<ComponentProps<'a'>, 'href'> & {
  readonly to: string
  /** Optional so a Button can render as a Link and pass its own children. */
  readonly children?: ReactNode
}) {
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a {...rest} href={to} onClick={follow}>
      {children}
    </a>
  )
}
