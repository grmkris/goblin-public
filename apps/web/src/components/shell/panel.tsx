import * as Data from 'effect/Data'
import { type ReactNode, createContext, use, useCallback, useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { type PanelItem, type PanelSearch, panelSearch } from '../../lib/panel.ts'
import { channelOf } from '../../lib/topics.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

/** The thread panel beside a channel: what it holds, and the ways to change that, all through the URL. */
type Panel = {
  readonly channel: string
  readonly items: readonly PanelItem[]
  /** Shows a thread (or subagent) of this channel, with the threads it sits in as the way back. */
  readonly open: (thread: string) => void
  /** A draft reply to `entry` of `conversation`, which becomes a thread from that message when it is sent. */
  readonly reply: (conversation: string, entry: number) => void
  /** A draft of a new, empty thread of the channel. */
  readonly newThread: () => void
  /** The draft on top became `thread`: the panel shows it in the draft's place. */
  readonly started: (thread: string) => void
  /** One step back: the thread under the top one, or the channel alone. */
  readonly back: () => void
  /** Closes the panel; what runs in its threads goes on. */
  readonly close: () => void
}

const PanelContext = createContext<Panel | undefined>(undefined)

/** A component asked for the panel outside a channel: a wiring mistake in the page, not a failure to show. */
class NoPanel extends Data.TaggedError('NoPanel')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message })
  }
}

export function usePanel(): Panel {
  const panel = use(PanelContext)
  if (panel === undefined) throw new NoPanel('usePanel outside a channel')
  return panel
}

/** The channel's panel for the components inside it, from the route's search. */
export function PanelProvider({
  channel,
  items,
  children,
}: {
  readonly channel: string
  readonly items: readonly PanelItem[]
  readonly children: ReactNode
}) {
  const navigate = useNavigate()
  const { conversations } = useWorkspaceFeed()
  const go = useCallback(
    (search: PanelSearch, replace = false) =>
      void navigate({ to: '/c/$chatId', params: { chatId: channel }, search, replace }),
    [navigate, channel],
  )
  const value = useMemo<Panel>(() => {
    return {
      channel,
      items,
      open: (thread) => go({ thread: Number(thread) }),
      reply: (conversation, entry) =>
        go({
          ...(conversation !== channel && { thread: Number(conversation) }),
          reply: `${conversation}-${entry}`,
        }),
      newThread: () => go({ reply: 'new' }),
      started: (thread) => go({ thread: Number(thread) }, true),
      back: () => go(panelSearch(items.slice(0, -1), channel, conversations)),
      close: () => go({}),
    }
  }, [channel, items, go, conversations])
  return <PanelContext value={value}>{children}</PanelContext>
}

/**
 * Opens any chat where it lives: a channel as itself, a thread or subagent in its channel's panel. What a link to a
 * thread in a transcript does, whichever channel that thread is in.
 */
export function useOpenChat(): (chat: string) => void {
  const navigate = useNavigate()
  const { conversations, topics } = useWorkspaceFeed()
  return useCallback(
    (chat: string) => {
      const channel = channelOf(chat, conversations, topics)
      navigate({
        to: '/c/$chatId',
        params: { chatId: channel },
        search: channel === chat ? {} : { thread: Number(chat) },
      }).catch(reportUnexpected)
    },
    [navigate, conversations, topics],
  )
}
