import { useEffect, useRef, useState } from 'react'
import { Option, Schema } from 'effect'
import { UsageToday } from '@goblin/contracts'
import { request } from '../lib/boundary.ts'

const decodeUsage = Schema.decodeUnknownOption(UsageToday)

/**
 * Today's model budget. It is read on mount and again whenever a run ends, since that is when a turn's spend is
 * recorded; `running` is the conversation's run state. A failed read keeps the last value.
 */
export function useUsageToday(running = false): UsageToday | undefined {
  const [usage, setUsage] = useState<UsageToday>()
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
      .then((data) => setUsage((previous) => Option.getOrElse(decodeUsage(data), () => previous)))
      .catch(() => undefined)
    return () => controller.abort()
  }, [reads])
  return usage
}
