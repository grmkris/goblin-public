// A small history router: five owner pages and two deep links that goblin and the OAuth flow open.
import { type MouseEvent, type ReactNode, useSyncExternalStore } from 'react'

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

export function Link({
  to,
  children,
  className,
  ...rest
}: {
  readonly to: string
  readonly children: ReactNode
  readonly className?: string
  readonly 'aria-current'?: 'page'
  readonly 'aria-label'?: string
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} onClick={onClick} className={className} {...rest}>
      {children}
    </a>
  )
}
