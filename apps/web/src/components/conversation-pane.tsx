import { useAccountWorkspaces } from '../lib/account-workspaces.tsx'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { type ConversationView, MAIN_THREAD } from '@purrable/contracts'
import { DropdownMenuItem, DropdownMenuSeparator, Input, useMediaQuery } from '@purrable/ui'
import { Maximize2Icon, Minimize2Icon, PencilIcon, RotateCcwIcon, ShareIcon, XIcon } from 'lucide-react'
import { failureText } from '../lib/boundary.ts'
import { WIDE_QUERY } from '../lib/breakpoints.ts'
import type { Part } from '../lib/parts.ts'
import { entryOfPart, isClosed, repliesLabel, rootParts, threadTitle } from '../lib/threads.ts'
import { activityState } from '../lib/workspace-feed.ts'
import { type ItemKey, conversationKey, itemOf, order } from '../lib/workspace.ts'
import { MessageComposer } from './composer.tsx'
import { useMarkRead, useOnScreen } from './on-screen.ts'
import { Conversation } from './conversation.tsx'
import { ConversationDock, Notice } from './conversation-dock.tsx'
import { useModelChoice } from './model-picker.tsx'
import { PaneHeader } from './pane-header.tsx'
import { WithoutApps } from './parts/mcp-tool-part.tsx'
import { PartView } from './parts/registry.tsx'
import { NO_BRANCHES, useInlineThreads } from './inline-thread.tsx'
import { postMessage, useConversation, useDockInsets, useTranscript } from './use-conversation.ts'
import { useWorkspace } from './workspace.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** What "Share to …" asks a thread's agent; it answers with `share_back`, into the conversation it came from. */
const SHARE_REQUEST = 'Share what we concluded here with the conversation this thread came from.'

/** What a pane says about a conversation's name: main is Main, the rest their titles. */
const nameOf = (view: ConversationView | undefined) => (view?.kind === 'main' ? 'Main' : threadTitle(view))

/** The message a thread branched from, then a rule with the count of what was said in the thread since. */
function ThreadRoot({ parts, replies }: { readonly parts: readonly Part[]; readonly replies: number }) {
  return (
    <div className="thread-root">
      {parts.map((part) => (
        <PartView key={part.id} part={part} canSwitchModel={false} />
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
  if (isClosed(view)) return <span className="pane-state">Closed</span>
  const state = activityState(feed, view.id)
  if (state === 'working') return <span className="thread-busy" aria-label="Working" />
  return state === 'waiting' ? <span className="pane-state">Waiting on helpers</span> : null
}

/** A conversation's name, editable in place. */
function RenameForm({ view, onDone }: { readonly view: ConversationView; readonly onDone: () => void }) {
  const { update } = useWorkspaceFeed()
  return (
    <form
      className="pane-rename"
      onSubmit={(event) => {
        event.preventDefault()
        const value = new FormData(event.currentTarget).get('title')
        const title = typeof value === 'string' ? value.trim() : ''
        if (title !== '') void update(view.id, { title }).then(onDone)
        else onDone()
      }}
    >
      <Input
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

/** The pill's menu for a conversation: rename, share back, fill the workspace, close or reopen. */
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
      {view.kind !== 'main' && view.canCompose !== false && (
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon aria-hidden />
          Rename
        </DropdownMenuItem>
      )}
      {view.kind === 'thread' && view.canCompose !== false && !closed && (
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
      {view.kind !== 'main' && view.canCompose !== false && (
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
      status={<Status view={view} />}
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
 * A conversation's transcript and dock. A branched thread starts at the message it branched from, shown above its
 * replies; every message carries the threads started from it, or Reply in thread. Apps open only from main for now.
 */
function ConversationBody({ view }: { readonly view: ConversationView }) {
  const { id } = view
  const item = conversationKey(id)
  const workspace = useWorkspace()
  const feed = useWorkspaceFeed()
  const pane = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(pane, dock)
  const { maximized } = workspace.state
  const placed = maximized === undefined || maximized === item
  const visible = useOnScreen(pane) && placed
  const reading = useOnScreen(pane, 0.5) && placed
  const conversation = useConversation(id, visible)
  const { projection, report } = conversation
  const { state: account } = useAccountWorkspaces()
  const canCompose = view.canCompose !== false && account?.active?.role !== 'viewer'
  const model = useModelChoice(report, account?.active?.role === 'owner')
  const fork = view.forkEntry
  const { parts, branchable, earlier } = useTranscript(id, projection, report, fork)
  useMarkRead(view, reading, account?.active?.role === 'owner')
  const inline = useInlineThreads(id, item, canCompose ? branchable : NO_BRANCHES)
  const root = fork === undefined ? [] : rootParts(parts, fork)
  const shown = useMemo(
    () => (fork === undefined ? parts : parts.filter((part) => entryOfPart(part.id) !== fork)),
    [parts, fork],
  )
  const transcript = (
    <Conversation
      parts={shown}
      canSwitchModel={(model.choice?.options.length ?? 0) > 1}
      threads={inline}
      {...(earlier && { onEarlier: earlier })}
      {...(root.length > 0 && { lead: <ThreadRoot parts={root} replies={view.replies} /> })}
    />
  )
  return (
    <section className="conversation-pane chat-pane" aria-label={nameOf(view)} ref={pane}>
      <ConversationHeader id={id} view={view} onShare={() => void conversation.send(SHARE_REQUEST)} />
      {id === MAIN_THREAD && account?.active?.role === 'owner' ? transcript : <WithoutApps>{transcript}</WithoutApps>}
      <ConversationDock
        ref={dock}
        id={id}
        conversation={conversation}
        model={model}
        parts={parts}
        closed={isClosed(view)}
        readOnly={!canCompose}
        onReopen={() => void feed.update(id, { closed: false })}
        notices={feed.error === '' ? [] : [feed.error]}
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
  async function start(input: string): Promise<boolean> {
    // A retry after a failed send reuses the thread the first attempt started.
    started.current ??= (await feed.create(from))?.id
    const thread = started.current
    if (thread === undefined) return false
    try {
      await postMessage(thread, input)
    } catch (failure) {
      setNotice(failureText(failure))
      return false
    }
    workspace.replace(item, conversationKey(thread))
    return true
  }
  const source = feed.conversations.find((view) => view.id === from?.conversation)
  let lead: ReactNode = (
    <p className="thread-intro">A new thread. Main learns its name once it starts, not what is said in it.</p>
  )
  if (from !== undefined) lead = <ThreadRoot parts={root} replies={0} />
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
