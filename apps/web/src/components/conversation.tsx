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
} from '@goblin/ui'
import { type ReactNode, useMemo, useRef } from 'react'
import { TELEGRAM_AUTHOR } from '@goblin/contracts'
import { HistoryIcon } from 'lucide-react'
import { isOwnTurn, type Part } from '../lib/parts.ts'
import { turnLabel } from '../lib/turn-map.ts'
import { PartView } from './parts/registry.tsx'
import { type InlineThreads, InlineThreadsProvider, MessageThreads } from './inline-thread.tsx'
import { OpenThread } from './parts/text-part.tsx'
import { type Turn, TurnMap } from './turn-map.tsx'

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
}: {
  readonly parts: readonly Part[]
  readonly canSwitchModel: boolean
  readonly threads?: InlineThreads
  /** Loads the page of history before the oldest part shown, while there is one. */
  readonly onEarlier?: () => void
  /** What comes before the parts (a thread's root message); with it, no empty state is shown. */
  readonly lead?: ReactNode
  /** The transcript is still on its way: no empty state yet. */
  readonly loading?: boolean
}) {
  const empty = !loading && parts.length === 0 && lead === undefined
  const viewport = useRef<HTMLDivElement>(null)
  const turns = useMemo(
    () =>
      parts
        .filter(isOwnTurn)
        .map((part): Turn => ({ id: part.id, label: turnLabel(part.text), telegram: part.author === TELEGRAM_AUTHOR })),
    [parts],
  )
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <InlineThreadsProvider value={threads}>
        <OpenThread value={threads?.open}>
          <MessageScroller>
            <MessageScrollerViewport aria-label="Conversation" ref={viewport}>
              <MessageScrollerContent>
                {onEarlier !== undefined && (
                  <button type="button" className="history-action" onClick={onEarlier}>
                    <HistoryIcon aria-hidden />
                    Earlier messages
                  </button>
                )}
                {lead}
                {empty ? (
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
                    <MessageScrollerItem key={part.id} messageId={part.id} scrollAnchor={isOwnTurn(part)}>
                      <div className="message-item flex flex-col" tabIndex={-1}>
                        <PartView part={part} canSwitchModel={canSwitchModel} />
                        {threads !== undefined && <MessageThreads part={part} threads={threads} />}
                      </div>
                    </MessageScrollerItem>
                  ))
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <TurnMap viewport={viewport} turns={turns} onEarlier={onEarlier} />
            <MessageScrollerButton direction="end" />
          </MessageScroller>
        </OpenThread>
      </InlineThreadsProvider>
    </MessageScrollerProvider>
  )
}
