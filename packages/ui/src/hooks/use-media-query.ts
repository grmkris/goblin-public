import { useEffect, useState } from 'react'

/** Whether `query` matches: false on the server render and the first client render (so they agree), then live. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const list = matchMedia(query)
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

/** The phone layout: below Tailwind's `md` breakpoint (48rem). */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
