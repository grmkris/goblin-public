import { useEffect, useRef, useState } from 'react'
import { Option, Schema } from 'effect'
import { UsageToday } from '@goblin/contracts'
import { failureText, request } from '../lib/boundary.ts'

const decodeUsage = Schema.decodeUnknownOption(UsageToday)

/** Today's usage as last read, and why the latest read failed, if it did. */
type UsageRead = { readonly usage: UsageToday | undefined; readonly failure: string }

/**
 * Today's model budget. It is read on mount and again whenever a run ends, since that is when a turn's spend is
 * recorded; `running` is the conversation's run state. A failed read keeps the last value and says why it failed.
 */
export function useUsageRead(running = false): UsageRead {
  const [read, setRead] = useState<UsageRead>({ usage: undefined, failure: '' })
  const wasRunning = useRef(running)
  const finished = wasRunning.current && !running
  wasRunning.current = running
  const [reads, setReads] = useState(0)
  useEffect(() => {
    if (finished) setReads((count) => count + 1)
  }, [finished])
  useEffect(() => {
    const controller = new AbortController()
    void request('/api/agent/usage', { signal: controller.signal })
      .then((data) =>
        setRead((previous) => ({ usage: Option.getOrElse(decodeUsage(data), () => previous.usage), failure: '' })),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRead((previous) => ({ ...previous, failure: failureText(error) }))
      })
    return () => controller.abort()
  }, [reads])
  return read
}

/** Today's usage for an indicator, which shows the last value it has and nothing before the first read succeeds. */
export const useUsageToday = (running = false): UsageToday | undefined => useUsageRead(running).usage
