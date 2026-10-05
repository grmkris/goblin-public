import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Schema } from 'effect'
import { ThreadView } from '@purrable/contracts'
import { failureText, request } from '../lib/boundary.ts'

const decodeThreads = Schema.decodeUnknownSync(Schema.Array(ThreadView))
const decodeThread = Schema.decodeUnknownSync(ThreadView)

type ThreadChange = { readonly title?: string; readonly archived?: boolean }
type Threads = {
  readonly views: readonly ThreadView[]
  readonly error: string
  readonly refresh: () => void
  /** A thread branched from main at `from` (an entry id), or an empty one; undefined when that failed (see `error`). */
  readonly create: (from?: number) => Promise<ThreadView | undefined>
  readonly update: (id: string, change: ThreadChange) => Promise<void>
}

const ThreadsContext = createContext<Threads | undefined>(undefined)

/**
 * The agent's conversations for the whole app (the sidebar, the chat bar, the reply rows), fetched once someone is
 * signed in (`enabled`) and again whenever a view changes them.
 */
export function ThreadsProvider({ enabled, children }: { readonly enabled: boolean; readonly children: ReactNode }) {
  const [views, setViews] = useState<readonly ThreadView[]>([])
  const [error, setError] = useState('')
  const refresh = useCallback(() => {
    if (!enabled) return
    request('/api/threads')
      .then((data) => setViews(decodeThreads(data)))
      .catch((failure: unknown) => setError(failureText(failure)))
  }, [enabled])
  useEffect(refresh, [refresh])
  const value = useMemo<Threads>(
    () => ({
      views,
      error,
      refresh,
      create: async (from) => {
        try {
          const view = decodeThread(await request('/api/threads', { body: from === undefined ? {} : { from } }))
          refresh()
          return view
        } catch (failure) {
          setError(failureText(failure))
          return undefined
        }
      },
      update: async (id, change) => {
        try {
          await request(`/api/threads/${id}`, { method: 'PATCH', body: change })
          refresh()
        } catch (failure) {
          setError(failureText(failure))
        }
      },
    }),
    [views, error, refresh],
  )
  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>
}

/** Moves the page to a conversation the owner just created (nothing when creating it failed). */
export function useGoToThread(): (created: ThreadView | undefined) => void {
  const navigate = useNavigate()
  return useCallback(
    (created) => {
      if (created) void navigate({ to: '/t/$threadId', params: { threadId: created.id } })
    },
    [navigate],
  )
}

export function useThreads(): Threads {
  const threads = useContext(ThreadsContext)
  if (threads === undefined) throw new Error('useThreads outside ThreadsProvider')
  return threads
}
