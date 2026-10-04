import { useMemo } from 'react'
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
import { conversationParts } from '../lib/parts.ts'
import type { ConversationProjection } from '../lib/projection.ts'
import { PartView } from './parts/registry.tsx'

/**
 * The transcript. It scrolls under the floating header and composer; each of the owner's turns is a scroll anchor, so
 * a new turn starts at the top of the view with a peek of the one before. It follows a streaming reply only while the
 * reader is already at the end, and offers a jump back when they are not.
 */
export function Conversation({
  projection,
  canSwitchModel,
}: {
  readonly projection: ConversationProjection | undefined
  readonly canSwitchModel: boolean
}) {
  const parts = useMemo(() => (projection === undefined ? [] : conversationParts(projection)), [projection])
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport aria-label="Conversation">
          <MessageScrollerContent>
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
