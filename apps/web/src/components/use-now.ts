import { useEffect, useState } from 'react'

/** The current time in milliseconds, ticking once a second while `active`, so running clocks advance. */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    // Caught up at once when it starts (its last value may be old), then once a second.
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}

/** Now in seconds, a minute at a time: what "2 minutes ago" is measured against. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
