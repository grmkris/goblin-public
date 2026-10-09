import { useEffect, useRef, useState } from 'react'
import type { ComposerSelection, ConversationView } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@goblin/ui'
import { ChevronLeftIcon, EllipsisIcon, PencilIcon, RotateCcwIcon, ShareIcon, XIcon } from 'lucide-react'
import { type PanelItem, draftFrom } from '../../lib/panel.ts'
import { rememberThread } from '../../lib/recent-threads.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { isClosed, rootParts, threadTitle } from '../../lib/threads.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { activityState } from '../../lib/workspace-feed.ts'
import { MessageComposer } from '../composer.tsx'
import type { SendExtras } from '../composer-state.ts'
import { Notice } from '../conversation-dock.tsx'
import { Conversation } from '../conversation.tsx'
import { useConversation, useDockInsets, useTranscript } from '../use-conversation.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { KindMark, SubagentMenuItems, SubagentState } from './chat-marks.tsx'
import { ChatView, ThreadRoot } from './chat-view.tsx'
import { takeDraft } from './drafts.ts'
import { usePanel } from './panel.tsx'
import { useDraftStart } from './thread-start.ts'

/** What "Share back" asks a thread's agent: it answers with `share_back`, into the chat it came from. */
const SHARE_REQUEST = 'Share what we concluded here with the conversation this thread came from.'

/** A thread's name, editable in place. */
function RenameForm({ view, onDone }: { readonly view: ConversationView; readonly onDone: () => void }) {
  const { update } = useWorkspaceFeed()
  return (
    <form
      className="panel-rename"
      onSubmit={(event) => {
        event.preventDefault()
        const value = new FormData(event.currentTarget).get('title')
        const title = typeof value === 'string' ? value.trim() : ''
        if (title !== '') update(view.id, { title }).then(onDone).catch(reportUnexpected)
        else onDone()
      }}
    >
      <Input
        variant="pill"
        name="title"
        defaultValue={view.title ?? ''}
        maxLength={120}
        aria-label="Thread name"
        autoFocus
        onBlur={onDone}
        onKeyDown={(event) => event.key === 'Escape' && onDone()}
      />
    </form>
  )
}

/**
 * A thread's menu: a subagent's Stop and Keep open, then Rename, Share back to the chat it came from, and Close thread,
 * which stops its work (closing the panel only hides it), or Reopen.
 */
function ThreadMenu({
  view,
  parent,
  onRename,
  onShare,
}: {
  readonly view: ConversationView
  readonly parent: string
  readonly onRename: () => void
  readonly onShare: () => void
}) {
  const { update } = useWorkspaceFeed()
  const closed = isClosed(view)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Thread actions" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {view.kind === 'subagent' && <SubagentMenuItems view={view} />}
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon aria-hidden />
          Rename
        </DropdownMenuItem>
        {view.kind === 'thread' && !closed && (
          <DropdownMenuItem onClick={onShare}>
            <ShareIcon aria-hidden />
            Share back to {parent}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void update(view.id, { closed: !closed })}>
          {closed ? <RotateCcwIcon aria-hidden /> : <XIcon aria-hidden />}
          {closed ? 'Reopen' : view.kind === 'subagent' ? 'Close subagent' : 'Close thread'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The panel's bar: the way back (to the thread it sits in, or where the panel covers it to the channel), what it shows and where that
 * lives, its menu, and × to close the panel. Closing the panel stops nothing.
 */
function PanelHeader({
  title,
  mark,
  status,
  menu,
  editing,
}: {
  readonly title: string
  readonly mark?: React.ReactNode
  readonly status?: React.ReactNode
  readonly menu?: React.ReactNode
  readonly editing?: React.ReactNode
}) {
  const panel = usePanel()
  const feed = useWorkspaceFeed()
  const under = panel.items.at(-2)
  const back = under?.kind === 'thread' ? feed.conversations.find((view) => view.id === under.id) : undefined
  const channel = threadTitle(feed.conversations.find((view) => view.id === panel.channel))
  return (
    <header className="panel-header" data-app-cover>
      {under !== undefined ? (
        <span className="panel-back">
          <Button variant="ghost" size="sm" onClick={panel.back}>
            <ChevronLeftIcon data-icon="inline-start" />
            <span className="truncate">{back === undefined ? 'Back' : threadTitle(back)}</span>
          </Button>
        </span>
      ) : (
        <span className="panel-back panel-crumb">
          <Button variant="ghost" size="sm" onClick={panel.close}>
            <ChevronLeftIcon data-icon="inline-start" />
            <span className="truncate">#{channel}</span>
          </Button>
        </span>
      )}
      <div className="panel-title">
        {mark !== undefined && <span className="panel-mark">{mark}</span>}
        {editing ?? <h2 className="truncate">{title}</h2>}
        {status}
      </div>
      {menu}
      <Button variant="ghost" size="icon" aria-label="Close panel" title="Close panel" onClick={panel.close}>
        <XIcon />
      </Button>
    </header>
  )
}

/** A thread in the panel: its bar with its menu and state, then the thread itself. */
function ThreadPanelView({ view, hideRoot }: { readonly view: ConversationView; readonly hideRoot: boolean }) {
  const feed = useWorkspaceFeed()
  const [renaming, setRenaming] = useState(false)
  const conversation = useConversation(view.id)
  const parent = threadTitle(feed.conversations.find((candidate) => candidate.id === view.parent))
  const working = activityState(feed, view.id) === 'working'
  const header = (
    <PanelHeader
      title={threadTitle(view)}
      mark={<KindMark view={view} />}
      status={
        view.kind === 'subagent' ? (
          <SubagentState view={view} />
        ) : working ? (
          <span className="thread-busy" aria-label="Working" />
        ) : undefined
      }
      menu={
        <ThreadMenu
          view={view}
          parent={parent}
          onRename={() => setRenaming(true)}
          onShare={() => void conversation.send(SHARE_REQUEST)}
        />
      }
      {...(renaming && { editing: <RenameForm view={view} onDone={() => setRenaming(false)} /> })}
    />
  )
  return <ChatView key={view.id} view={view} place="panel" active header={header} hideRoot={hideRoot} />
}

const NOTHING_TO_STOP = () => undefined

/**
 * A thread before it exists: a reply to a message (shown above it) or a new empty thread of the channel. Sending
 * starts the thread, from that message or empty, and the panel shows it; a draft left unsent leaves nothing behind
 * (Pi cannot delete a conversation).
 */
function DraftView({ item, topic }: { readonly item: PanelItem; readonly topic: number | undefined }) {
  const panel = usePanel()
  const feed = useWorkspaceFeed()
  const from = draftFrom(item)
  const source = useConversation(from?.conversation ?? panel.channel)
  const { parts } = useTranscript(from?.conversation ?? panel.channel, source.projection, source.report)
  const root = from === undefined ? [] : rootParts(parts, from.entry)
  const [notice, setNotice] = useState('')
  const [draft] = useState(takeDraft)
  const startDraft = useDraftStart(from?.conversation ?? panel.channel, topic)
  const section = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(section, dock)
  async function start(
    input: string,
    attachments: readonly string[],
    selections: readonly ComposerSelection[],
    { personaOrder }: SendExtras,
  ) {
    try {
      const thread = await startDraft({
        anchor: from === undefined ? 'empty' : { entry: from.entry },
        message: { input, attachments, selections },
        ...(personaOrder !== undefined && { personaOrder }),
      })
      if (thread === undefined) return false
      panel.started(thread)
      return true
    } catch (failure) {
      setNotice(messageOf(failure, 'send the message'))
      if (selections.length > 0) throw failure
      return false
    }
  }
  const parent = threadTitle(feed.conversations.find((view) => view.id === (from?.conversation ?? panel.channel)))
  return (
    <section className="chat-view" data-place="panel" aria-label="New thread" ref={section} data-app-scope>
      <PanelHeader title="New thread" />
      <Conversation
        parts={[]}
        canSwitchModel={false}
        lead={from === undefined ? <span /> : <ThreadRoot parts={root} replies={0} from={parent} />}
      />
      <div className="chat-dock" ref={dock}>
        <Notice text={notice} />
        <MessageComposer
          conversation={from?.conversation ?? panel.channel}
          draft={draft}
          onNewThread={() => undefined}
          attach
          autoFocus
          onSend={start}
          running={false}
          onStop={NOTHING_TO_STOP}
          placeholder="Reply…"
        />
      </div>
    </section>
  )
}

/**
 * The thread panel beside a channel (a full view on a phone): the thread on top of its stack, or a draft that becomes
 * one when it is sent. Threads opened inside it stack, with a back crumb to the one under; × closes the panel and
 * leaves what runs in its threads running.
 */
export function ThreadPanel({
  topic,
  heads,
}: {
  readonly topic: number | undefined
  /** Threads the channel shows a head for: no root message above their first one. */
  readonly heads: ReadonlySet<string>
}) {
  const panel = usePanel()
  const feed = useWorkspaceFeed()
  const top = panel.items.at(-1)
  const shown = top?.kind === 'thread' ? top.id : undefined
  useEffect(() => {
    if (shown !== undefined) rememberThread(shown)
  }, [shown])
  if (top === undefined) return null
  let body = null
  if (top.kind === 'thread') {
    const view = feed.conversations.find((candidate) => candidate.id === top.id)
    body =
      view === undefined ? (
        <section className="chat-view" data-place="panel" aria-busy>
          <PanelHeader title="Thread" />
        </section>
      ) : (
        <ThreadPanelView view={view} hideRoot={heads.has(view.id)} />
      )
  } else
    body = <DraftView key={top.kind === 'new' ? 'new' : `${top.conversation}-${top.entry}`} item={top} topic={topic} />
  return (
    <aside className="thread-panel" aria-label="Thread" data-app-overlay>
      {body}
    </aside>
  )
}
