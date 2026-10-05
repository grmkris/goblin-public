import { Link } from '@tanstack/react-router'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@purrable/ui'
import { PlusIcon } from 'lucide-react'
import { threadTitle } from '../lib/threads.ts'
import { conversationKey, isOpen } from '../lib/workspace.ts'
import { type RowStatus, type TreeNode, pathOf, railItems, rowStatus } from '../lib/workspace-tree.ts'
import { KindIcon, useRowActions, useWorkspaceTree } from './sidebar-tree.tsx'
import { useWorkspace } from './workspace.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

const KIND = { main: 'Main conversation', thread: 'Thread', subagent: 'Subagent' } as const

/** What the hover card says the conversation is doing. */
function stateLabel(status: RowStatus): string {
  if (status.state === 'working') return 'working'
  if (status.state === 'waiting') return 'waiting on its subagents'
  if (status.below) return 'work going on under it'
  return status.unread ? 'unread replies' : 'idle'
}

/**
 * One conversation on the rail: its kind's icon, a bar while it is the focused pane, a dot while it is open in another,
 * and its state in the corner. Resting on it shows what it is, where it sits and what a click does.
 */
function RailItem({ node }: { readonly node: TreeNode }) {
  const feed = useWorkspaceFeed()
  const status = rowStatus(node, feed.activity)
  const row = useRowActions(node.view.id)
  const name = threadTitle(node.view)
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Link
            to="/c/$conversationId"
            params={{ conversationId: node.view.id }}
            onClick={row.showHere}
            className="rail-item"
            aria-label={name}
            data-kind={node.view.kind}
            data-focused={row.focused}
            data-open={row.open}
            data-state={status.state === 'idle' && status.below ? 'below' : status.state}
            data-unread={status.unread}
            data-drag-item={row.key}
          />
        }
      >
        <KindIcon kind={node.view.kind} />
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">
          {KIND[node.view.kind]} · {stateLabel(status)}
          {row.open && !row.focused ? ' · open in a pane' : ''}
        </p>
        <p className="text-xs">{pathOf(feed.conversations, node.view.id, threadTitle).join(' › ')}</p>
        <p className="text-xs text-muted-foreground">Click to show it here; drag it onto a pane to place it there.</p>
      </HoverCardContent>
    </HoverCard>
  )
}

/**
 * The folded sidebar: main and the conversations of its tree that are active (open in a pane, at work or with unread
 * replies), then the active threads, then a new thread. The sidebar is never hidden altogether on a desktop.
 */
export function WorkspaceRail({ onNew }: { readonly onNew: () => void }) {
  const feed = useWorkspaceFeed()
  const { state } = useWorkspace()
  const items = railItems(useWorkspaceTree(), feed.activity, (id) => isOpen(state, conversationKey(id)))
  return (
    <nav className="workspace-rail" aria-label="Conversations">
      {items.main.map((node) => (
        <RailItem key={node.view.id} node={node} />
      ))}
      {items.threads.length > 0 && <hr className="rail-separator" />}
      {items.threads.map((node) => (
        <RailItem key={node.view.id} node={node} />
      ))}
      <button type="button" className="rail-item" aria-label="New thread" title="New thread" onClick={onNew}>
        <PlusIcon aria-hidden />
      </button>
    </nav>
  )
}
