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
import type { ConversationProjection, ToolCallView } from '../lib/projection.ts'
import { MessageText, MessageView } from './chat-message.tsx'

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
  const messages = projection?.messages ?? []
  const calls = useMemo(() => {
    const map = new Map<string, ToolCallView>()
    for (const message of messages)
      if (message.role === 'assistant') for (const call of message.toolCalls) map.set(call.id, call)
    return map
  }, [messages])
  const running = projection?.tools.filter((tool) => tool.status === 'running') ?? []
  const empty = messages.length === 0 && !projection?.partial
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport aria-label="Conversation">
          <MessageScrollerContent>
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
              messages.map((message) => (
                <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}>
                  <div className="flex flex-col gap-3">
                    <MessageView message={message} calls={calls} canSwitchModel={canSwitchModel} />
                  </div>
                </MessageScrollerItem>
              ))
            )}
            {running.length > 0 && (
              <MessageScrollerItem messageId="live-tools">
                <div className="flex flex-col gap-1">
                  {running.map((tool) => (
                    <p className="text-sm text-muted-foreground" key={tool.callId}>
                      Running {tool.name}…
                    </p>
                  ))}
                </div>
              </MessageScrollerItem>
            )}
            {projection?.partial && (
              <MessageScrollerItem messageId="partial">
                <div className="flex flex-col">
                  <article className="bubble bubble-assistant">
                    <MessageText text={projection.partial} />
                  </article>
                </div>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
