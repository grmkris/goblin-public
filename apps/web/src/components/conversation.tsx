import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@goblin/ui'
import { type ReactNode, useMemo, useRef } from 'react'
import { TELEGRAM_AUTHOR } from '@goblin/contracts'
import { HistoryIcon } from 'lucide-react'
import { isOwnTurn, type Part, partKey } from '../lib/parts.ts'
import { turnLabel } from '../lib/turn-map.ts'
import { PartView } from './parts/registry.tsx'
import { type InlineThreads, InlineThreadsProvider, MessageThreads } from './inline-thread.tsx'
import { OpenThread } from './parts/text-part.tsx'
import { HomeLanding, NowButton } from './home/landing.tsx'
import { HomeSurface } from './home/surface.tsx'
import { HOME_MARK } from '../lib/home.ts'
import { glide } from '../lib/motion.ts'
import { type Turn, TurnMap } from './turn-map.tsx'

type ConversationProps = {
  readonly parts: readonly Part[]
  readonly canSwitchModel: boolean
  readonly threads?: InlineThreads
  /** Loads the page of history before the oldest part shown, while there is one. */
  readonly onEarlier?: () => void
  /** What comes before the parts (a thread's root message); with it, no empty state is shown. */
  readonly lead?: ReactNode
  /** The transcript is still on its way: no empty state yet. */
  readonly home?: { readonly onDraft: (text: string) => void } | undefined
  readonly loading?: boolean
}

/** A thread's way to its end; it jumps instead of gliding when the person asks for less motion. */
function EndButton() {
  const { scrollToEnd } = useMessageScroller()
  return (
    <MessageScrollerButton
      direction="end"
      onClick={(event) => {
        event.preventDefault()
        scrollToEnd({ behavior: glide() })
      }}
    />
  )
}

/**
 * The transcript. It scrolls under the floating header and composer; each of the owner's turns (`isOwnTurn`) is a
 * scroll anchor, so a new turn starts at the top of the view with a peek of the one before, while messages from
 * anyone else arrive without moving it. It follows a streaming reply only while the reader is already at the end, and
 * offers a jump back when they are not. `threads` puts each thread under the message it branched from, unfolding in
 * place, and offers Reply in thread on the others. While `loading`, it shows nothing, so the first content it gets is
 * the transcript itself and opens at its end. The turn map on its right edge (`TurnMap`) jumps between the owner's
 * turns.
 */
export function Conversation({
  parts,
  canSwitchModel,
  threads,
  onEarlier,
  lead,
  loading = false,
  home,
}: ConversationProps) {
  const empty = !loading && parts.length === 0 && lead === undefined
  const viewport = useRef<HTMLDivElement>(null)
  const turns = useMemo(() => {
    const own = parts
      .filter(isOwnTurn)
      .map((part): Turn => ({ id: part.id, label: turnLabel(part.text), telegram: part.author === TELEGRAM_AUTHOR }))
    return home === undefined ? own : [...own, { id: HOME_MARK, label: 'Home', telegram: false }]
  }, [parts, home])
  return (
    <MessageScrollerProvider autoScroll {...(home === undefined && { defaultScrollPosition: 'end' as const })}>
      <InlineThreadsProvider value={threads}>
        <OpenThread value={threads?.open}>
          <MessageScroller data-home-transcript={home !== undefined || undefined}>
            <MessageScrollerViewport aria-label="Conversation" ref={viewport}>
              <MessageScrollerContent>
                {onEarlier !== undefined && (
                  <button type="button" className="history-action" onClick={onEarlier}>
                    <HistoryIcon aria-hidden />
                    Earlier messages
                  </button>
                )}
                {lead}
                {empty && home === undefined ? (
                  <Empty className="m-auto">
                    <EmptyHeader>
                      <EmptyTitle>Your conversation starts here</EmptyTitle>
                      <EmptyDescription>
                        Ask anything. Your agent can use the tools you enable under Connections.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  parts.map((part) => (
                    <MessageScrollerItem key={partKey(part)} messageId={part.id} scrollAnchor={isOwnTurn(part)}>
                      <div className="message-item flex flex-col" tabIndex={-1}>
                        <PartView part={part} canSwitchModel={canSwitchModel} />
                        {threads !== undefined && <MessageThreads part={part} threads={threads} />}
                      </div>
                    </MessageScrollerItem>
                  ))
                )}
                {home !== undefined && !loading && (
                  <MessageScrollerItem messageId={HOME_MARK}>
                    <HomeSurface onDraft={home.onDraft} />
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <TurnMap viewport={viewport} turns={turns} onEarlier={onEarlier} />
            {home === undefined ? (
              <EndButton />
            ) : (
              <>
                <HomeLanding parts={parts} loading={loading} viewport={viewport} />
                <NowButton parts={parts} />
              </>
            )}
          </MessageScroller>
        </OpenThread>
      </InlineThreadsProvider>
    </MessageScrollerProvider>
  )
}
