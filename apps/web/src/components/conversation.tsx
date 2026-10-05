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
} from '@purrable/ui'
import type { ReactNode } from 'react'
import { HistoryIcon } from 'lucide-react'
import type { Part } from '../lib/parts.ts'
import { PartView } from './parts/registry.tsx'
import { OpenThread } from './parts/text-part.tsx'
import { type InlineThreads, PartThreads } from './thread-replies.tsx'

/**
 * The transcript. It scrolls under the floating header and composer; each of the owner's turns is a scroll anchor, so
 * a new turn starts at the top of the view with a peek of the one before. It follows a streaming reply only while the
 * reader is already at the end, and offers a jump back when they are not. `threads` (main only) puts each thread under
 * the message it branched from and offers Reply in thread on the others.
 */
export function Conversation({
  parts,
  canSwitchModel,
  threads,
  onEarlier,
  lead,
}: {
  readonly parts: readonly Part[]
  readonly canSwitchModel: boolean
  readonly threads?: InlineThreads
  /** Loads the page of history before the oldest part shown, while there is one. */
  readonly onEarlier?: () => void
  /** What comes before the parts (a thread's root message); with it, no empty state is shown. */
  readonly lead?: ReactNode
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <OpenThread value={threads?.open}>
        <MessageScroller>
          <MessageScrollerViewport aria-label="Conversation">
            <MessageScrollerContent>
              {onEarlier !== undefined && (
                <button type="button" className="history-action" onClick={onEarlier}>
                  <HistoryIcon aria-hidden />
                  Earlier messages
                </button>
              )}
              {lead}
              {parts.length === 0 && lead === undefined ? (
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
                  <MessageScrollerItem key={part.id} messageId={part.id} scrollAnchor={part.kind === 'user'}>
                    <div className="flex flex-col">
                      <PartView part={part} canSwitchModel={canSwitchModel} />
                      {threads !== undefined && <PartThreads part={part} threads={threads} />}
                    </div>
                  </MessageScrollerItem>
                ))
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </OpenThread>
    </MessageScrollerProvider>
  )
}
