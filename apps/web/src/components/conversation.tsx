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
import { memo, type ReactNode, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TELEGRAM_AUTHOR } from '@goblin/contracts'
import { HistoryIcon } from 'lucide-react'
import { isOwnTurn, type Part, partKey, samePart } from '../lib/parts.ts'
import { turnLabel } from '../lib/turn-map.ts'
import { PartView } from './parts/registry.tsx'
import { OpenThread } from './parts/text-part.tsx'
import { type ChatThreads, MessageFooter } from './shell/thread-summary.tsx'
import { glide } from '../lib/motion.ts'
import { serversQuery } from '../mcp/queries.ts'
import { unconnectedProfiles } from './connect-offer.tsx'
import { type Turn, TurnMap } from './turn-map.tsx'

type ConversationProps = {
  readonly parts: readonly Part[]
  readonly canSwitchModel: boolean
  /** The chat's threads: under each message the ones it started, and Reply in thread. */
  readonly threads?: ChatThreads
  /** Opens a chat a transcript names (a thread a note came from, a subagent that reported) where it lives. */
  readonly onOpen?: (chat: string) => void
  /** Loads the page of history before the oldest part shown, while there is one. */
  readonly onEarlier?: () => void
  /** What comes before the parts (a thread's root message); with it, no empty state is shown. */
  readonly lead?: ReactNode
  /** The transcript is still on its way: no empty state yet. */
  readonly loading?: boolean
  /** What shows under a part beside its own footer (a source strip, an owner-only message). */
  readonly after?: (part: Part) => ReactNode
  /** What comes after the parts (Personas still answering). */
  readonly trail?: ReactNode
}

/** In an empty chat, the first-class servers goblin could use once the owner connects them (ADR 0043). */
function NotConnectedYet() {
  const [first] = unconnectedProfiles(useQuery(serversQuery).data ?? [])
  if (first?.profile === undefined) return null
  return (
    <EmptyDescription>
      Connect {first.profile.title} on Connections, {first.profile.offer}.
    </EmptyDescription>
  )
}

/**
 * A message's actions and threads, memoised like its part (`samePart`): a streamed batch rebuilds every part, and
 * without this every message's toolbar and Details drawer rendered again with each batch, in proportion to the
 * transcript's length.
 */
const Footer = memo(
  MessageFooter,
  (before, after) => before.threads === after.threads && samePart(before.part, after.part),
)

/** A conversation's way to its end; it jumps instead of gliding when the person asks for less motion. */
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
  onOpen,
  onEarlier,
  lead,
  loading = false,
  after,
  trail,
}: ConversationProps) {
  const empty = !loading && parts.length === 0 && lead === undefined
  const viewport = useRef<HTMLDivElement>(null)
  const turns = useMemo(
    () =>
      parts.filter(isOwnTurn).map((part): Turn => ({
        id: part.id,
        label: turnLabel(part.text),
        telegram: part.kind === 'user' && part.author === TELEGRAM_AUTHOR,
      })),
    [parts],
  )
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <OpenThread value={onOpen}>
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
                    <EmptyTitle>No messages yet</EmptyTitle>
                    <NotConnectedYet />
                  </EmptyHeader>
                </Empty>
              ) : (
                parts.map((part) => (
                  <MessageScrollerItem key={partKey(part)} messageId={part.id} scrollAnchor={isOwnTurn(part)}>
                    <div className="message-item flex flex-col" tabIndex={-1}>
                      <PartView part={part} canSwitchModel={canSwitchModel} />
                      {threads !== undefined && <Footer part={part} threads={threads} />}
                      {after?.(part)}
                    </div>
                  </MessageScrollerItem>
                ))
              )}
              {trail}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <TurnMap viewport={viewport} turns={turns} onEarlier={onEarlier} />
          <EndButton />
        </MessageScroller>
      </OpenThread>
    </MessageScrollerProvider>
  )
}
