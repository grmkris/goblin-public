import { useEffect, useState } from 'react'

/** The current time in milliseconds, ticking once a second while `active`, so running clocks advance. */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
