import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Schema } from 'effect'
import {
  AppView,
  ConversationView,
  type CreateConversation,
  HomeEditResult,
  type HomeLayout,
  type HomeOperation,
  type UpdateConversation,
} from '@goblin/contracts'
import { failureText, request } from '../lib/boundary.ts'
import { BrowserPiEvents } from '../lib/conversation-stream.ts'
import { previewHome } from '../lib/home.ts'
import {
  EMPTY_WORKSPACE,
  type PendingHome,
  WorkspaceFeedConnection,
  type WorkspaceState,
  applyChanges,
  withPendingApps,
  withPendingHome,
} from '../lib/workspace-feed.ts'

const decodeView = Schema.decodeUnknownSync(ConversationView)
const decodeApp = Schema.decodeUnknownSync(AppView)
const decodeHomeResult = Schema.decodeUnknownSync(HomeEditResult)

type WorkspaceFeed = WorkspaceState & {
  readonly error: string
  /** A thread branched `from` a message, or an empty one; undefined when that failed (see `error`). */
  readonly create: (from?: CreateConversation['from']) => Promise<ConversationView | undefined>
  readonly update: (id: string, change: UpdateConversation) => Promise<void>
  /** The owner has seen the conversation's newest reply: it shows read at once, and the server keeps the mark. */
  readonly markRead: (id: string) => void
  /** Keeps the App of call `callId` in `conversation`, reopening it if it was closed. Throws when the call has none. */
  readonly keepApp: (conversation: string, callId: string) => Promise<AppView>
  /** Closes a kept App: its iframe goes everywhere, and its place offers to show it again. Throws on failure. */
  readonly closeApp: (id: string) => Promise<void>
  /** Opens a closed App again (an agent app, whose view the owner closed). */
  readonly reopenApp: (id: string) => Promise<AppView>
  /**
   * The owner's edit of Home: shown at once, in the same event as the gesture that made it, then as the server answers.
   * A refusal or failure puts Home back as it was and throws (a 409 when another edit landed first).
   */
  readonly editHome: (ops: readonly HomeOperation[]) => Promise<HomeEditResult>
}

const WorkspaceFeedContext = createContext<WorkspaceFeed | undefined>(undefined)

/**
 * The feed's state, live while `enabled`, with the Apps the owner just kept or closed (`pending`) and the Home edit
 * they just made (`pendingHome`) shown so over whatever the feed sends until it sends them so too.
 */
function useLiveFeed(enabled: boolean) {
  const [state, setState] = useState<WorkspaceState>(EMPTY_WORKSPACE)
  const [error, setError] = useState('')
  const pending = useRef(new Map<string, AppView>())
  const pendingHome = useRef<PendingHome>(undefined)
  useEffect(() => {
    if (!enabled) return
    const publish = (next: WorkspaceState) => {
      const shown = withPendingApps(next, pending.current)
      for (const id of shown.settled) pending.current.delete(id)
      const home = withPendingHome(shown.state, pendingHome.current)
      if (home.settled) pendingHome.current = undefined
      setState(home.state)
    }
    const connection = new WorkspaceFeedConnection(
      () => new BrowserPiEvents('/api/workspace/events'),
      publish,
      (problem) => setError(problem ?? ''),
    )
    connection.connect()
    return () => connection.dispose()
  }, [enabled])
  return { state, setState, error, setError, pending, pendingHome }
}

/**
 * The owner's Home edit (`WorkspaceFeed.editHome`), against the layout they see (`before`): shown at once as the
 * pending Home, then the server's layout; on a refusal or failure Home goes back to `before`, unless the feed has
 * moved on meanwhile.
 */
function homeEditor(
  before: HomeLayout | undefined,
  setState: Dispatch<SetStateAction<WorkspaceState>>,
  pendingHome: RefObject<PendingHome | undefined>,
) {
  return async (ops: readonly HomeOperation[]): Promise<HomeEditResult> => {
    if (before === undefined) throw new Error('Home has not loaded yet')
    // Shown before the request goes out: set from the gesture's own event, it paints with the drop, not after it.
    const shown: PendingHome = {
      until: before.revision + 1,
      layout: { revision: before.revision, tiles: previewHome(before.tiles, ops) },
    }
    pendingHome.current = shown
    setState((current) => withPendingHome(current, shown).state)
    const restore = () => {
      if (pendingHome.current === shown) pendingHome.current = undefined
      setState((current) => (current.home?.revision === before.revision ? { ...current, home: before } : current))
    }
    try {
      const result = decodeHomeResult(
        await request('/api/home', {
          body: {
            // @effect-diagnostics-next-line cryptoRandomUUID:off -- each explicit owner edit has a new durable operation ID.
            operationId: crypto.randomUUID(),
            expectedRevision: before.revision,
            ops,
          },
        }),
      )
      if (result.kind !== 'applied') restore()
      else {
        pendingHome.current = { until: result.layout.revision, layout: result.layout }
        setState((current) => applyChanges(current, [{ type: 'home', home: result.layout }]))
      }
      return result
    } catch (failure) {
      restore()
      throw failure
    }
  }
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
  const { state, setState, error, setError, pending, pendingHome } = useLiveFeed(enabled)
  const markRead = useCallback((id: string) => {
    const at = Math.floor(Date.now() / 1000)
    setState((current) => {
      const view = current.conversations.find((candidate) => candidate.id === id)
      if (view === undefined) return current
      const readAt = Math.max(at, view.lastReplyAt ?? 0, view.readAt ?? 0)
      return applyChanges(current, [{ type: 'conversation', conversation: { ...view, readAt } }])
    })
    request(`/api/conversations/${id}/read`, { method: 'PUT', body: {} }).catch((failure: unknown) =>
      setError(failureText(failure)),
    )
  }, [])
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
      editHome: homeEditor(state.home, setState, pendingHome),
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
  }, [state, error, markRead])
  return <WorkspaceFeedContext.Provider value={value}>{children}</WorkspaceFeedContext.Provider>
}

export function useWorkspaceFeed(): WorkspaceFeed {
  const feed = useContext(WorkspaceFeedContext)
  if (feed === undefined) throw new Error('useWorkspaceFeed outside WorkspaceFeedProvider')
  return feed
}
