import { useRef, useState } from 'react'
import type { HomeOperation } from '@goblin/contracts'
import { ApiFailure, failureText } from '../../lib/boundary.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

const STALE = 'Home changed in another tab. Try this edit again.'

/** What went wrong with a Home edit, in words: the server answers a stale revision with 409. */
export const homeFailureText = (cause: unknown, stale = STALE): string =>
  cause instanceof ApiFailure && cause.status === 409 ? stale : failureText(cause)

/**
 * Owner controls use the same revision and replay boundary as the agent. The edit shows at once (the feed's pending
 * Home) and goes back if the server refuses it. Never replay stale intent silently.
 */
export function useHomeEdit() {
  const feed = useWorkspaceFeed()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const busy = useRef(false)
  const edit = async (ops: readonly HomeOperation[]) => {
    if (feed.home === undefined || busy.current) return
    busy.current = true
    setPending(true)
    setNotice('')
    try {
      if ((await feed.editHome(ops)).kind !== 'applied') setNotice(STALE)
    } catch (cause) {
      setNotice(homeFailureText(cause))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { edit, pending, notice }
}
