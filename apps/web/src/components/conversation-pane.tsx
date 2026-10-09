import { type ReactNode, useMemo, useRef, useState } from 'react'
import { PRIMARY_CHAT, type ComposerSelection, type ConversationView } from '@goblin/contracts'
import { DropdownMenuItem, DropdownMenuSeparator, Input, useMediaQuery } from '@goblin/ui'
import {
  GitBranchIcon,
  Maximize2Icon,
  MessageCircleIcon,
  Minimize2Icon,
  PencilIcon,
  RotateCcwIcon,
  ShareIcon,
  XIcon,
} from 'lucide-react'
import { failureText } from '../lib/boundary.ts'
import { WIDE_QUERY } from '../lib/breakpoints.ts'
import { type Part, partKey } from '../lib/parts.ts'
import { closedBy, entryOfPart, isClosed, repliesLabel, rootParts, threadTitle } from '../lib/threads.ts'
import { activityState } from '../lib/workspace-feed.ts'
import { type ItemKey, conversationKey, itemOf, order } from '../lib/workspace.ts'
import { MessageComposer } from './composer.tsx'
import { useMarkRead, useOnScreen } from './on-screen.ts'
import { Conversation } from './conversation.tsx'
import { ConversationDock, Notice } from './conversation-dock.tsx'
import { useModelChoice } from './model-picker.tsx'
import { KindMark, ShowInPane, SubagentMenuItems, SubagentPillState } from './pane-nav.tsx'
import { PaneHeader } from './pane-header.tsx'
import { AppsIn } from './parts/mcp-tool-part.tsx'
import { PartView } from './parts/registry.tsx'
import { Cause } from './parts/text-part.tsx'
import { useInlineThreads } from './inline-thread.tsx'
import { postMessage, useConversation, useDockInsets, useTranscript } from './use-conversation.ts'
import { useWorkspace } from './workspace.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** What "Share to …" asks a thread's agent; it answers with `share_back`, into the conversation it came from. */
const SHARE_REQUEST = 'Share what we concluded here with the conversation this thread came from.'

/** What a pane says about a conversation's name: main is Main, the rest their titles. */
const nameOf = (view: ConversationView | undefined) => (view?.kind === 'main' ? 'Main' : threadTitle(view))

/**
 * The message a thread branched from, under where it came from, then a rule with the count of what was said in the
 * thread since.
 */
function ThreadRoot({
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
          Branched from <b>{from}</b>
        </span>
      </p>
      {parts.map((part) => (
        <PartView key={partKey(part)} part={part} canSwitchModel={false} />
      ))}
      <p className="thread-rule">{repliesLabel(replies)}</p>
    </div>
  )
}

/**
 * Whether this pane offers the sidebar (the first in reading order, or any pane on a narrow screen, where each fills
 * it), whether it is the only one, and whether it fills the workspace.
 */
export function usePlace(item: ItemKey) {
  const { state } = useWorkspace()
  const wide = useMediaQuery(WIDE_QUERY)
  const items = order(state)
  return { first: items[0] === item || !wide, only: items.length <= 1, maximized: state.maximized === item }
}

/** What the agent of a conversation is doing, as the pill shows it. */
function Status({ view }: { readonly view: ConversationView | undefined }) {
  const feed = useWorkspaceFeed()
  if (view === undefined) return null
  if (isClosed(view)) return <span className="pane-state">{view.closedBy === 'done' ? 'Done' : 'Closed'}</span>
  const state = activityState(feed, view.id)
  if (state === 'working') return <span className="thread-busy" aria-label="Working" />
  return state === 'waiting' ? <span className="pane-state">Waiting on helpers</span> : null
}

/** A conversation's name, editable in place. */
function RenameForm({ view, onDone }: { readonly view: ConversationView; readonly onDone: () => void }) {
  const { update } = useWorkspaceFeed()
  return (
    <form
      className="min-w-40"
      onSubmit={(event) => {
        event.preventDefault()
        const value = new FormData(event.currentTarget).get('title')
        const title = typeof value === 'string' ? value.trim() : ''
        if (title !== '') void update(view.id, { title }).then(onDone)
        else onDone()
      }}
    >
      <Input
        variant="pill"
        name="title"
        defaultValue={view.title ?? ''}
        maxLength={120}
        aria-label="Conversation name"
        autoFocus
        onBlur={onDone}
        onKeyDown={(event) => event.key === 'Escape' && onDone()}
      />
    </form>
  )
}

/**
 * The pill's menu for a conversation: where it sits and what is around it to show here, a subagent's Stop and Keep
 * open, then rename, share back, fill the workspace, close or reopen.
 */
function ConversationMenu({
  view,
  item,
  parentName,
  onRename,
  onShare,
}: {
  readonly view: ConversationView
  readonly item: ItemKey
  readonly parentName: string
  readonly onRename: () => void
  readonly onShare: () => void
}) {
  const { update } = useWorkspaceFeed()
  const workspace = useWorkspace()
  const { maximized, only } = usePlace(item)
  const closed = isClosed(view)
  return (
    <>
      <ShowInPane view={view} item={item} />
      <DropdownMenuSeparator />
      {view.kind === 'subagent' && <SubagentMenuItems view={view} />}
      {view.kind !== 'main' && (
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon aria-hidden />
          Rename
        </DropdownMenuItem>
      )}
      {view.kind === 'thread' && !closed && (
        <DropdownMenuItem onClick={onShare}>
          <ShareIcon aria-hidden />
          Share to {parentName}
        </DropdownMenuItem>
      )}
      {!only && (
        <DropdownMenuItem onClick={() => workspace.maximize(maximized ? undefined : item)}>
          {maximized ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
          {maximized ? 'Show all panes' : 'Fill the workspace'}
        </DropdownMenuItem>
      )}
      {view.kind !== 'main' && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void update(view.id, { closed: !closed })}>
            {closed ? <RotateCcwIcon aria-hidden /> : <XIcon aria-hidden />}
            {closed ? 'Reopen' : `Close ${view.kind}`}
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

/** The pill of a conversation's pane: where it came from, its name and menu, what it is doing, and close. */
function ConversationHeader({
  id,
  view,
  onShare,
}: {
  readonly id: string
  readonly view: ConversationView | undefined
  readonly onShare?: () => void
}) {
  const item = conversationKey(id)
  const workspace = useWorkspace()
  const feed = useWorkspaceFeed()
  const { first, only } = usePlace(item)
  const [renaming, setRenaming] = useState(false)
  const parent = feed.conversations.find((candidate) => candidate.id === view?.parent)
  const parentName = nameOf(parent)
  return (
    <PaneHeader
      item={item}
      title={nameOf(view)}
      first={first}
      {...(view !== undefined && { mark: <KindMark view={view} /> })}
      status={view?.kind === 'subagent' ? <SubagentPillState view={view} /> : <Status view={view} />}
      onClose={only ? undefined : () => workspace.close(item)}
      crumb={
        parent === undefined
          ? undefined
          : { title: parentName, open: () => workspace.open(conversationKey(parent.id), 'beside', item) }
      }
      {...(renaming && view !== undefined && { editing: <RenameForm view={view} onDone={() => setRenaming(false)} /> })}
      menu={
        view === undefined || onShare === undefined ? undefined : (
          <ConversationMenu
            view={view}
            item={item}
            parentName={parentName}
            onRename={() => setRenaming(true)}
            onShare={onShare}
          />
        )
      }
    />
  )
}

/**
 * What writing in a conversation does, said by its composer where that is not obvious: a thread is an aside its parent
 * sees nothing of; writing to a subagent steers it, and its answer goes to the conversation that started it.
 */
function composerOf(view: ConversationView, conversations: readonly ConversationView[]) {
  const parent = nameOf(conversations.find((candidate) => candidate.id === view.parent))
  if (view.kind === 'thread')
    return {
      placeholder: 'Reply in thread…',
      hint: `An aside from ${parent}. Nothing here reaches it unless you share it.`,
    }
  if (view.kind === 'subagent')
    return {
      placeholder: `Steer ${nameOf(view)}…`,
      sendLabel: 'Steer',
      hint: `It started with ${parent}'s model and tools. Its answers go to ${parent}; writing while it works steers it.`,
    }
  return {}
}

/**
 * A conversation's transcript and dock. A branched thread starts at the message it branched from, shown above its
 * replies; every message carries the threads started from it, or Reply in thread. The owner's Apps live in place.
 */
function ConversationBody({ view }: { readonly view: ConversationView }) {
  const { id } = view
  const item = conversationKey(id)
  const workspace = useWorkspace()
  const feed = useWorkspaceFeed()
  const pane = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(pane, dock)
  const { maximized, docked } = workspace.state
  const placed = maximized === undefined || maximized === item || docked === item
  const visible = useOnScreen(pane) && placed
  const reading = useOnScreen(pane, 0.5) && placed
  const conversation = useConversation(id, visible)
  const { projection, report } = conversation
  const model = useModelChoice(report)
  const fork = view.forkEntry
  const { parts, branchable, earlier } = useTranscript(id, projection, report, fork)
  useMarkRead(view, reading)
  const inline = useInlineThreads(id, item, branchable)
  const root = fork === undefined ? [] : rootParts(parts, fork)
  const parentName = nameOf(feed.conversations.find((candidate) => candidate.id === view.parent))
  // A subagent's first message is the task its spawner gave it: shown as that, not as the owner's words.
  const first = parts[0]
  const task =
    view.kind === 'subagent' && earlier === undefined && first?.kind === 'user' && first.author === undefined
      ? first
      : undefined
  const shown = useMemo(
    () => parts.filter((part) => part !== task && (fork === undefined || entryOfPart(part.id) !== fork)),
    [parts, fork, task],
  )
  const transcript = (
    <Conversation
      parts={shown}
      canSwitchModel={(model.choice?.options.length ?? 0) > 1}
      threads={inline}
      loading={projection === undefined}
      {...(earlier && { onEarlier: earlier })}
      {...(root.length > 0 && {
        lead: (
          <AppsIn conversation={undefined}>
            <ThreadRoot parts={root} replies={view.replies} from={parentName} />
          </AppsIn>
        ),
      })}
      {...(task !== undefined && {
        lead: (
          <Cause
            icon={<MessageCircleIcon aria-hidden />}
            line={
              <>
                Task from <b>{parentName}</b>
              </>
            }
            text={task.text}
          />
        ),
      })}
    />
  )
  return (
    <section className="conversation-pane chat-pane" aria-label={nameOf(view)} ref={pane}>
      <ConversationHeader id={id} view={view} onShare={() => void conversation.send(SHARE_REQUEST)} />
      <AppsIn conversation={id}>{transcript}</AppsIn>
      <ConversationDock
        ref={dock}
        id={id}
        conversation={conversation}
        model={model}
        parts={parts}
        closed={closedBy(view)}
        onReopen={() => void feed.update(id, { closed: false })}
        notices={feed.error === '' ? [] : [feed.error]}
        active={workspace.state.focused === item}
        {...composerOf(view, feed.conversations)}
      />
    </section>
  )
}

/**
 * One conversation in its pane. Until the feed lists it the pane cannot tell where a thread branched, so it waits
 * rather than show its parent's history.
 */
export function ConversationPane({ id }: { readonly id: string }) {
  const { conversations } = useWorkspaceFeed()
  const view = conversations.find((candidate) => candidate.id === id)
  if (view === undefined)
    return (
      <section className="conversation-pane chat-pane" aria-busy>
        <ConversationHeader id={id} view={undefined} />
      </section>
    )
  return <ConversationBody key={id} view={view} />
}

const NOTHING_TO_STOP = () => undefined

/**
 * A thread before it exists: a reply to a message (shown above it) or a new empty thread. Sending starts the thread,
 * from that message or empty, and the pane becomes it; a draft left unsent leaves nothing behind (Pi cannot delete a
 * conversation).
 */
export function DraftPane({ item }: { readonly item: ItemKey }) {
  const workspace = useWorkspace()
  const feed = useWorkspaceFeed()
  const { first, only } = usePlace(item)
  const draft = itemOf(item)
  const from = draft?.kind === 'draft' ? draft.from : undefined
  const root = workspace.draftRoot(item)
  const [notice, setNotice] = useState('')
  const started = useRef<string | undefined>(undefined)
  const pane = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(pane, dock)
  async function start(
    input: string,
    attachments: readonly string[],
    selections: readonly ComposerSelection[],
  ): Promise<boolean> {
    // A retry after a failed send reuses the thread the first attempt started.
    started.current ??= (await feed.create(from))?.id
    const thread = started.current
    if (thread === undefined) return false
    try {
      await postMessage(thread, input, undefined, { attachments, selections })
    } catch (failure) {
      setNotice(failureText(failure))
      if (selections.length > 0) throw failure
      return false
    }
    workspace.replace(item, conversationKey(thread))
    return true
  }
  const source = feed.conversations.find((view) => view.id === from?.conversation)
  let lead: ReactNode = (
    <p className="thread-intro">A new thread. Main learns its name once it starts, not what is said in it.</p>
  )
  if (from !== undefined) lead = <ThreadRoot parts={root} replies={0} from={nameOf(source)} />
  return (
    <section className="conversation-pane chat-pane" aria-label="New thread" ref={pane}>
      <PaneHeader
        item={item}
        title="New thread"
        first={first}
        crumb={
          source === undefined
            ? undefined
            : {
                title: nameOf(source),
                open: () => workspace.open(conversationKey(source.id), 'beside', item),
              }
        }
        onClose={only ? undefined : () => workspace.close(item)}
      />
      <Conversation parts={[]} canSwitchModel={false} lead={lead} />
      <div className="chat-dock" ref={dock}>
        <Notice text={notice} />
        <MessageComposer
          conversation={from?.conversation ?? PRIMARY_CHAT}
          draft={workspace.draftContents(item)}
          onNewThread={(contents) => workspace.moveDraft(contents, item)}
          attach
          autoFocus
          onSend={start}
          running={false}
          onStop={NOTHING_TO_STOP}
          placeholder={from === undefined ? 'Message the new thread…' : 'Reply in thread…'}
          context={<span className="truncate text-xs text-muted-foreground">Sending starts a thread here</span>}
        />
      </div>
    </section>
  )
}
