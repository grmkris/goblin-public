import { useCallback, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageToday } from '@goblin/contracts'
import { usageQuery } from '../agent/queries.ts'

/** Today's usage as last read, the latest read's failure (null when it worked), and a way to read again. */
type UsageRead = { readonly usage: UsageToday | undefined; readonly error: unknown; readonly retry: () => void }

/**
 * Today's model budget. It is read on mount and again whenever a run ends, since that is when a turn's spend is
 * recorded; `running` is the conversation's run state. A failed read keeps the last value and says why it failed.
 */
export function useUsageRead(running = false): UsageRead {
  const read = useQuery(usageQuery)
  const { refetch } = read
  const reread = useCallback(() => void refetch(), [refetch])
  // The run state as of the last effect: compared there, not during render, so render stays pure.
  const wasRunning = useRef(running)
  useEffect(() => {
    const finished = wasRunning.current && !running
    wasRunning.current = running
    if (finished) reread()
  }, [running, reread])
  return { usage: read.data, error: read.error, retry: reread }
}

/** Today's usage for an indicator, which shows the last value it has and nothing before the first read succeeds. */
export const useUsageToday = (running = false): UsageToday | undefined => useUsageRead(running).usage
