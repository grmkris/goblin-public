// What a conversation's pane pill shows beyond its name: a mark of what it is (main, a thread, or a subagent's state),
// a subagent's state in words, and at the top of its menu where it sits and the conversations around it to show in
// the same pane instead.
import type { ConversationView } from '@goblin/contracts'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from '@goblin/ui'
import { ArrowUpIcon, MessageCircleIcon, MessagesSquareIcon, PinIcon, SquareIcon } from 'lucide-react'
import { isBusy, subagentState, workingUnder } from '../lib/subagent-state.ts'
import { threadTitle } from '../lib/threads.ts'
import { type ItemKey, conversationKey } from '../lib/workspace.ts'
import { pathOf } from '../lib/workspace-tree.ts'
import { SubagentStateIcon, SubagentStateText, useSubagent } from './parts/subagent-block.tsx'
import { useWorkspace } from './workspace.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** How many conversations under this one the menu lists; the sidebar has the rest. */
const SHOWN_CHILDREN = 6

/** What a conversation is, as a small mark: main, a thread, or a subagent's state. */
export function KindMark({ view }: { readonly view: ConversationView }) {
  const { activity } = useWorkspaceFeed()
  if (view.kind === 'subagent') return <SubagentStateIcon state={subagentState(view, activity.get(view.id))} />
  return view.kind === 'main' ? <MessageCircleIcon aria-hidden /> : <MessagesSquareIcon aria-hidden />
}

/** A subagent's state in its pill: its clock while it works, else where it stands. */
export function SubagentPillState({ view }: { readonly view: ConversationView }) {
  const { activity } = useWorkspaceFeed()
  return (
    <span className="pane-state">
      <SubagentStateText state={subagentState(view, activity.get(view.id))} />
    </span>
  )
}

const newestFirst = (a: ConversationView, b: ConversationView) =>
  b.createdAt - a.createdAt || Number(b.id) - Number(a.id)

/**
 * The top of a conversation's menu: its path from main, then the conversation it came from and the ones under it
 * (main's threads have their own group in the sidebar), each shown in this pane on a click.
 */
export function ShowInPane({ view, item }: { readonly view: ConversationView; readonly item: ItemKey }) {
  const feed = useWorkspaceFeed()
  const workspace = useWorkspace()
  const parent = feed.conversations.find((candidate) => candidate.id === view.parent)
  const children = feed.conversations
    .filter(
      (candidate) =>
        candidate.parent === view.id &&
        !(view.kind === 'main' && candidate.kind === 'thread') &&
        (candidate.kind !== 'thread' || candidate.replies > 0),
    )
    .toSorted(newestFirst)
  const show = (id: string) => workspace.open(conversationKey(id), { into: item })
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{pathOf(feed.conversations, view.id, threadTitle).join(' › ')}</DropdownMenuLabel>
      {parent !== undefined && (
        <DropdownMenuItem onClick={() => show(parent.id)}>
          <ArrowUpIcon aria-hidden />
          {threadTitle(parent)}
          <span className="menu-hint">{view.kind === 'thread' ? 'branched from' : 'started it'}</span>
        </DropdownMenuItem>
      )}
      {children.slice(0, SHOWN_CHILDREN).map((child) => (
        <DropdownMenuItem key={child.id} onClick={() => show(child.id)}>
          <KindMark view={child} />
          {threadTitle(child)}
          <span className="menu-hint">{child.kind === 'thread' ? 'thread' : 'subagent'}</span>
        </DropdownMenuItem>
      ))}
      {children.length > SHOWN_CHILDREN && (
        <DropdownMenuLabel>and {children.length - SHOWN_CHILDREN} more in the sidebar</DropdownMenuLabel>
      )}
    </DropdownMenuGroup>
  )
}

/** A subagent's own actions in its menu: Stop it and all under it while anything works, and Keep open past its report. */
export function SubagentMenuItems({ view }: { readonly view: ConversationView }) {
  const subagent = useSubagent(view)
  const feed = useWorkspaceFeed()
  const closed = subagent.state.kind === 'closed'
  const below = workingUnder(view.id, feed.conversations, feed.activity)
  return (
    <>
      {!closed && isBusy(subagent.state, below) && (
        <DropdownMenuItem onClick={subagent.stop}>
          <SquareIcon aria-hidden />
          {below > 0 ? 'Stop it and all under it' : 'Stop'}
        </DropdownMenuItem>
      )}
      {!closed && !view.keepOpen && (
        <DropdownMenuItem onClick={subagent.keepOpen}>
          <PinIcon aria-hidden />
          Keep open after its report
        </DropdownMenuItem>
      )}
    </>
  )
}
