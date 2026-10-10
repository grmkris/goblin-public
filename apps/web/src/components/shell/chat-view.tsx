import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ConversationView } from '@goblin/contracts'
import { GitBranchIcon, MessageCircleIcon } from 'lucide-react'
import { modelQuery } from '../../agent/queries.ts'
import { type Part, partKey } from '../../lib/parts.ts'
import { closedBy, entryOfPart, movableEntry, repliesLabel, rootParts, threadTitle } from '../../lib/threads.ts'
import { useConversation as useFeedConversation, useFeedStatus } from '../../lib/workspace/hooks.ts'
import { updateWorkspaceConversationMutation } from '../../lib/workspace/mutations.ts'
import { Conversation } from '../conversation.tsx'
import { ConversationDock } from '../conversation-dock.tsx'
import { useMarkRead, useOnScreen } from '../on-screen.ts'
import { AppsIn } from '../parts/mcp-tool-part.tsx'
import { PartView } from '../parts/registry.tsx'
import { Cause } from '../parts/text-part.tsx'
import { useConversation, useDockInsets, useTranscript } from '../use-conversation.ts'
import { useChatExtras } from './chat-extras.tsx'
import { useMover } from './move-action.tsx'
import { useOpenChat } from './panel.tsx'
import { useThreadStart } from './thread-start.ts'
import { useChatThreads } from './thread-summary.tsx'

/** Where a chat shows: the channel's column, or the thread panel beside it. */
export type ChatPlace = 'channel' | 'panel'

/** The message a thread started from, under where it came from, then a rule with the count of its replies. */
export function ThreadRoot({
  parts,
  replies,
  from,
}: {
  readonly parts: readonly Part[]
  readonly replies: number
  readonly from: string
}) {
  return (
    <div className="thread-root">
      <p className="cause-line">
        <GitBranchIcon aria-hidden />
        <span>
          From <b>{from}</b>
        </span>
      </p>
      {parts.map((part) => (
        <PartView key={partKey(part)} part={part} canSwitchModel={false} />
      ))}
      <p className="thread-rule">{repliesLabel(replies)}</p>
    </div>
  )
}

/** What writing in a chat does where it is not obvious: a subagent is steered; a channel is messaged by name. */
function composerOf(view: ConversationView, place: ChatPlace) {
  if (view.kind === 'subagent') return { placeholder: `Steer ${threadTitle(view)}…`, sendLabel: 'Steer' }
  if (place === 'panel') return { placeholder: 'Reply…' }
  return { placeholder: `Message #${threadTitle(view)}` }
}

/**
 * What comes before a chat's own messages: in the panel, a thread's first message (where it came from), or a
 * subagent's task as its spawner gave it; a channel starts with its own history.
 */
function useLead(view: ConversationView, parts: readonly Part[], earlier: boolean, hideRoot: boolean) {
  const parent = threadTitle(useFeedConversation(view.parent))
  const fork = view.forkEntry
  const first = parts[0]
  const task =
    view.kind === 'subagent' && !earlier && first?.kind === 'user' && first.author === undefined ? first : undefined
  const root = fork === undefined || hideRoot ? [] : rootParts(parts, fork)
  const shown = useMemo(
    () => parts.filter((part) => part !== task && (fork === undefined || entryOfPart(part.id) !== fork)),
    [parts, fork, task],
  )
  let lead: ReactNode
  if (task !== undefined)
    lead = (
      <Cause
        icon={<MessageCircleIcon aria-hidden />}
        line={
          <>
            Task from <b>{parent}</b>
          </>
        }
        text={task.text}
      />
    )
  else if (root.length > 0)
    lead = (
      <AppsIn conversation={undefined}>
        <ThreadRoot parts={root} replies={view.replies} from={parent} />
      </AppsIn>
    )
  return { lead, shown }
}

/**
 * One chat, a channel or a thread: its header, its transcript (each message with the threads it started, or Reply in
 * thread) and its dock. A thread in the panel starts at the message it came from and reads none of the history before
 * it. The chat follows its stream while it is on screen and marks itself read once the owner has seen it.
 */
export function ChatView({
  view,
  place,
  active,
  header,
  hideRoot = false,
  banner,
  onHeads,
  notices = [],
}: {
  readonly view: ConversationView
  readonly place: ChatPlace
  /** The owner is working here now: its presence may move. */
  readonly active: boolean
  readonly header: ReactNode
  /** The thread started as a head in its channel, which shows that message: no root above its first message. */
  readonly hideRoot?: boolean
  /** In place of the composer (an archived Topic's channel). */
  readonly banner?: ReactNode
  /** Told which threads this chat shows a head for, as they come. */
  readonly onHeads?: (heads: ReadonlySet<string>) => void
  /** What went wrong around the chat (organizing its Topic), shown above the composer. */
  readonly notices?: readonly string[]
}) {
  const { id } = view
  const status = useFeedStatus()
  const update = useMutation(updateWorkspaceConversationMutation).mutate
  const openChat = useOpenChat()
  const section = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(section, dock)
  const visible = useOnScreen(section)
  const reading = useOnScreen(section, 0.5)
  const conversation = useConversation(id, visible)
  const { projection, report } = conversation
  const models = useQuery(modelQuery).data?.options.length ?? 0
  const fork = place === 'panel' ? view.forkEntry : undefined
  const { parts, branchable, earlier } = useTranscript(id, projection, report, fork)
  useMarkRead(view, reading)
  const running = projection?.running ?? false
  const movable = useMemo(() => movableEntry(parts), [parts])
  const mover = useMover(id, place === 'channel', running, movable)
  const threads = useChatThreads(id, branchable, mover)
  const startThread = useThreadStart(id)
  const { lead, shown } = useLead(view, parts, earlier !== undefined, hideRoot)
  const extras = useChatExtras(id, shown)
  const heads = useMemo(
    () => parts.flatMap((part) => (part.kind === 'thread-head' ? [part.thread] : [])).join(' '),
    [parts],
  )
  useEffect(() => onHeads?.(new Set(heads === '' ? [] : heads.split(' '))), [heads, onHeads])
  return (
    <section className="chat-view" data-place={place} aria-label={threadTitle(view)} ref={section} data-app-scope>
      {header}
      <AppsIn conversation={id}>
        <Conversation
          parts={shown}
          canSwitchModel={models > 1}
          threads={threads}
          onOpen={openChat}
          after={extras.after}
          trail={extras.trail}
          loading={projection === undefined}
          {...(earlier && { onEarlier: earlier })}
          {...(lead !== undefined && { lead })}
        />
      </AppsIn>
      {banner ?? (
        <ConversationDock
          ref={dock}
          id={id}
          conversation={conversation}
          parts={parts}
          closed={closedBy(view)}
          onReopen={() => update({ id, change: { closed: false } })}
          notices={[...notices, ...(status === '' ? [] : [status])]}
          active={active}
          {...(view.kind !== 'subagent' && { onStartThread: startThread })}
          {...composerOf(view, place)}
        />
      )}
    </section>
  )
}
