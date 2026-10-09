import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Schema } from 'effect'
import {
  AppView,
  type ConversationView,
  type CreateConversation,
  type UpdateConversation,
  type WorkspaceChange,
} from '@goblin/contracts'
import {
  conversationKeys,
  createConversationMutation,
  markReadMutation,
  updateConversationMutation,
} from '../conversations/queries.ts'
import { request } from '../lib/boundary.ts'
import { BrowserPiEvents } from '../lib/conversation-stream.ts'
import {
  EMPTY_WORKSPACE,
  WorkspaceFeedConnection,
  type WorkspaceState,
  applyChanges,
  withPendingApps,
} from '../lib/workspace-feed.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { reportUnexpected } from '../lib/unexpected.ts'
import { personaKeys } from '../personas/queries.ts'

const decodeApp = Schema.decodeUnknownSync(AppView)

type WorkspaceFeed = WorkspaceState & {
  readonly error: string
  /** A thread branched `from` a message, or an empty one of `topic`; undefined when that failed (see `error`). */
  readonly create: (from?: CreateConversation['from'], topic?: number) => Promise<ConversationView | undefined>
  readonly update: (id: string, change: UpdateConversation) => Promise<void>
  /** The owner has seen the conversation's newest reply: it shows read at once, and the server keeps the mark. */
  readonly markRead: (id: string) => void
  /** Keeps the App of call `callId` in `conversation`, reopening it if it was closed. Throws when the call has none. */
  readonly keepApp: (conversation: string, callId: string) => Promise<AppView>
  /** Closes a kept App: its iframe goes everywhere, and its place offers to show it again. Throws on failure. */
  readonly closeApp: (id: string) => Promise<void>
  /** Opens a closed App again (an agent app, whose view the owner closed). */
  readonly reopenApp: (id: string) => Promise<AppView>
  /** Shows what the server just answered a change with (a Topic, a Persona, a receipt) before the feed repeats it. */
  readonly apply: (changes: readonly WorkspaceChange[]) => void
}

const WorkspaceFeedContext = createContext<WorkspaceFeed | undefined>(undefined)

/**
 * The feed's state, live while `enabled`, with the Apps the owner just kept or closed (`pending`)
 * shown over whatever the feed sends until it confirms them. The feed is also what says that server data changed: a
 * Persona change makes the Persona reads, and what composers can tag, read again.
 */
function useLiveFeed(enabled: boolean) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<WorkspaceState>(EMPTY_WORKSPACE)
  const [error, setError] = useState('')
  const pending = useRef(new Map<string, AppView>())
  useEffect(() => {
    if (!enabled) return
    let personas: WorkspaceState['personas'] | undefined
    const publish = (next: WorkspaceState) => {
      const shown = withPendingApps(next, pending.current)
      for (const id of shown.settled) pending.current.delete(id)
      setState(shown.state)
      if (personas !== undefined && next.personas !== personas)
        Promise.all([
          queryClient.invalidateQueries({ queryKey: personaKeys.all }),
          queryClient.invalidateQueries({ queryKey: conversationKeys.composers }),
        ]).catch(reportUnexpected)
      personas = next.personas
    }
    const connection = new WorkspaceFeedConnection(
      () => new BrowserPiEvents('/api/workspace/events'),
      publish,
      (problem) => setError(problem ?? ''),
    )
    connection.connect()
    return () => connection.dispose()
  }, [enabled, queryClient])
  return { state, setState, error, setError, pending }
}

/**
 * The owner's conversations, what each is doing and their kept Apps, for the whole app, from one live feed opened once
 * someone is signed in with an agent (`enabled`). Creating or changing a conversation shows at once; the feed confirms
 * it.
 */
export function WorkspaceFeedProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean
  readonly children: ReactNode
}) {
  const { state, setState, error, setError, pending } = useLiveFeed(enabled)
  const read = useMutation(markReadMutation).mutate
  const created = useMutation(createConversationMutation).mutateAsync
  const updated = useMutation(updateConversationMutation).mutateAsync
  const markRead = useCallback(
    (id: string) => {
      const at = Math.floor(Date.now() / 1000)
      setState((current) => {
        const view = current.conversations.find((candidate) => candidate.id === id)
        if (view === undefined) return current
        const readAt = Math.max(at, view.lastReplyAt ?? 0, view.readAt ?? 0)
        return applyChanges(current, [{ type: 'conversation', conversation: { ...view, readAt } }])
      })
      read(id, { onError: (failure) => setError(messageOf(failure, 'mark it read')) })
    },
    [setState, setError, read],
  )
  const value = useMemo<WorkspaceFeed>(() => {
    const show = (view: ConversationView) =>
      setState((current) => applyChanges(current, [{ type: 'conversation', conversation: view }]))
    const showApp = (app: AppView) => {
      pending.current.set(app.id, app)
      setState((current) => applyChanges(current, [{ type: 'app', app }]))
      return app
    }
    return {
      ...state,
      error,
      markRead,
      apply: (changes) => setState((current) => applyChanges(current, changes)),
      keepApp: async (conversation, callId) =>
        showApp(decodeApp(await request('/api/apps', { body: { conversation, callId } }))),
      closeApp: async (id) => {
        // Shown closed at once, so nothing loads it again while the server confirms; back as it was if that fails.
        const before = state.apps.find((app) => app.id === id)
        if (before !== undefined) showApp({ ...before, closedAt: Math.floor(Date.now() / 1000) })
        try {
          showApp(decodeApp(await request(`/api/apps/${id}`, { method: 'PATCH', body: { closed: true } })))
        } catch (failure) {
          pending.current.delete(id)
          if (before !== undefined) setState((current) => applyChanges(current, [{ type: 'app', app: before }]))
          throw failure
        }
      },
      reopenApp: async (id) =>
        showApp(decodeApp(await request(`/api/apps/${id}`, { method: 'PATCH', body: { closed: false } }))),
      create: async (from, topic) => {
        try {
          const body = {
            ...(from !== undefined && { from }),
            ...(from === undefined && topic !== undefined && { topic }),
          }
          const view = await created(body)
          show(view)
          return view
        } catch (failure) {
          setError(messageOf(failure, 'start the thread'))
          return undefined
        }
      },
      update: async (id, change) => {
        try {
          show(await updated({ id, change }))
        } catch (failure) {
          setError(messageOf(failure, 'change the conversation'))
        }
      },
    }
  }, [state, error, markRead, setState, setError, pending, created, updated])
  return <WorkspaceFeedContext.Provider value={value}>{children}</WorkspaceFeedContext.Provider>
}

export function useWorkspaceFeed(): WorkspaceFeed {
  const feed = useContext(WorkspaceFeedContext)
  if (feed === undefined) throw new Error('useWorkspaceFeed outside WorkspaceFeedProvider')
  return feed
}
