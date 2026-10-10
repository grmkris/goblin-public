import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageToday } from '@goblin/contracts'
import { usageQuery } from '../agent/queries.ts'

/** Today's usage as last read, the latest read's failure (null when it worked), and a way to read again. */
type UsageRead = { readonly usage: UsageToday | undefined; readonly error: unknown; readonly retry: () => void }

/**
 * Today's model budget. It is read on mount and again whenever a run ends, since that is when a turn's spend is
 * recorded (the workspace feed says so, `lib/workspace/invalidations.ts`). A failed read keeps the last value and says
 * why it failed.
 */
export function useUsageRead(): UsageRead {
  const read = useQuery(usageQuery)
  const { refetch } = read
  const reread = useCallback(() => void refetch(), [refetch])
  return { usage: read.data, error: read.error, retry: reread }
}

/** Today's usage for an indicator, which shows the last value it has and nothing before the first read succeeds. */
export const useUsageToday = (): UsageToday | undefined => useUsageRead().usage
