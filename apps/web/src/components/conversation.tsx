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
import { HistoryIcon, SplitIcon } from 'lucide-react'
import type { Part } from '../lib/parts.ts'
import { entryOfPart } from '../lib/threads.ts'
import { PartView } from './parts/registry.tsx'

/** A settled answer can start a thread: the thread sees the conversation up to it. */
function BranchAction({ part, onBranch }: { readonly part: Part; readonly onBranch: (entry: number) => void }) {
  const entry = part.kind === 'text' && !part.live ? entryOfPart(part.id) : undefined
  if (entry === undefined) return null
  return (
    <button type="button" className="message-action" onClick={() => onBranch(entry)}>
      <SplitIcon aria-hidden />
      Branch from here
    </button>
  )
}

/**
 * The transcript. It scrolls under the floating header and composer; each of the owner's turns is a scroll anchor, so
 * a new turn starts at the top of the view with a peek of the one before. It follows a streaming reply only while the
 * reader is already at the end, and offers a jump back when they are not. `onBranch` (main only) offers a thread from
 * each settled answer.
 */
export function Conversation({
  parts,
  canSwitchModel,
  onBranch,
  onEarlier,
}: {
  readonly parts: readonly Part[]
  readonly canSwitchModel: boolean
  readonly onBranch?: (entry: number) => void
  /** Loads the page of history before the oldest part shown, while there is one. */
  readonly onEarlier?: () => void
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport aria-label="Conversation">
          <MessageScrollerContent>
            {onEarlier !== undefined && (
              <button type="button" className="history-action" onClick={onEarlier}>
                <HistoryIcon aria-hidden />
                Earlier messages
              </button>
            )}
            {parts.length === 0 ? (
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
                    {onBranch !== undefined && <BranchAction part={part} onBranch={onBranch} />}
                  </div>
                </MessageScrollerItem>
              ))
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
