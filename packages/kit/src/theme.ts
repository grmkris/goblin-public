import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

function subscribe(change: () => void): () => void {
  const observer = new MutationObserver(change)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

/** The page's theme (goblin puts `dark` on the root element), following it as it changes. */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, current, () => 'light')
