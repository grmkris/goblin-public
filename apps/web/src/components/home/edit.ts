import { useRef, useState } from 'react'
import { HomeEditResult, type HomeOperation } from '@goblin/contracts'
import { Schema } from 'effect'
import { failureText, request } from '../../lib/boundary.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

/** Owner controls use the same revision and replay boundary as the agent. Never replay stale intent silently. */
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
      const result = Schema.decodeUnknownSync(HomeEditResult)(
        await request('/api/home', {
          body: {
            // @effect-diagnostics-next-line cryptoRandomUUID:off -- each explicit owner edit has a new durable operation ID.
            operationId: crypto.randomUUID(),
            expectedRevision: feed.home.revision,
            ops,
          },
        }),
      )
      if (result.kind !== 'applied') setNotice('Home changed in another tab. Try this edit again.')
    } catch (cause) {
      setNotice(failureText(cause))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { edit, pending, notice }
}
