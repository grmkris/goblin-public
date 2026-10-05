import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Schema } from 'effect'
import { ConversationView, type CreateConversation, type UpdateConversation } from '@purrable/contracts'
import { failureText, request } from '../lib/boundary.ts'
import { BrowserPiEvents } from '../lib/conversation-stream.ts'
import { EMPTY_WORKSPACE, WorkspaceFeedConnection, type WorkspaceState, applyChanges } from '../lib/workspace-feed.ts'

const decodeView = Schema.decodeUnknownSync(ConversationView)

type WorkspaceFeed = WorkspaceState & {
  readonly error: string
  /** A thread branched `from` a message, or an empty one; undefined when that failed (see `error`). */
  readonly create: (from?: CreateConversation['from']) => Promise<ConversationView | undefined>
  readonly update: (id: string, change: UpdateConversation) => Promise<void>
}

const WorkspaceFeedContext = createContext<WorkspaceFeed | undefined>(undefined)

/**
 * The owner's conversations and what each is doing, for the whole app, from one live feed opened once someone is
 * signed in with an agent (`enabled`). Creating or changing a conversation shows at once; the feed confirms it.
 */
export function WorkspaceFeedProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean
  readonly children: ReactNode
}) {
  const [state, setState] = useState<WorkspaceState>(EMPTY_WORKSPACE)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return
    const connection = new WorkspaceFeedConnection(
      () => new BrowserPiEvents('/api/workspace/events'),
      setState,
      (problem) => setError(problem ?? ''),
    )
    connection.connect()
    return () => connection.dispose()
  }, [enabled])
  const value = useMemo<WorkspaceFeed>(() => {
    const show = (view: ConversationView) =>
      setState((current) => applyChanges(current, [{ type: 'conversation', conversation: view }]))
    return {
      ...state,
      error,
      create: async (from) => {
        try {
          const view = decodeView(await request('/api/conversations', { body: from === undefined ? {} : { from } }))
          show(view)
          return view
        } catch (failure) {
          setError(failureText(failure))
          return undefined
        }
      },
      update: async (id, change) => {
        try {
          show(decodeView(await request(`/api/conversations/${id}`, { method: 'PATCH', body: change })))
        } catch (failure) {
          setError(failureText(failure))
        }
      },
    }
  }, [state, error])
  return <WorkspaceFeedContext.Provider value={value}>{children}</WorkspaceFeedContext.Provider>
}

export function useWorkspaceFeed(): WorkspaceFeed {
  const feed = useContext(WorkspaceFeedContext)
  if (feed === undefined) throw new Error('useWorkspaceFeed outside WorkspaceFeedProvider')
  return feed
}
