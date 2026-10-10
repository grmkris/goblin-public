import { type ReactNode, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkspaceSnapshot } from '@goblin/contracts'
import { BrowserPiEvents } from '../lib/conversation-stream.ts'
import { workspaceSync } from '../lib/workspace/sync.ts'

/**
 * The owner's workspace for the whole app, in the Query cache (`lib/workspace/`): one live feed opened once someone is
 * signed in with an agent (`enabled`), which writes each slice as it changes; components read them with the hooks of
 * `lib/workspace/hooks.ts`. Without `enabled` nothing connects: a page or fixture that gives a `snapshot` reads that.
 */
export function WorkspaceFeedProvider({
  enabled,
  snapshot,
  children,
}: {
  readonly enabled: boolean
  /** What the slices hold without a feed (a fixture's workspace), written once, before the first render. */
  readonly snapshot?: WorkspaceSnapshot
  readonly children: ReactNode
}) {
  const queryClient = useQueryClient()
  useState(() => {
    if (snapshot !== undefined) workspaceSync(queryClient).snapshot(snapshot)
  })
  useEffect(() => {
    if (!enabled) return
    return workspaceSync(queryClient).connect(() => new BrowserPiEvents('/api/workspace/events'))
  }, [enabled, queryClient])
  return children
}
