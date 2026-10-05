import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import type { ConversationView } from '@purrable/contracts'
import {
  Duration,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from '@purrable/ui'
import { BotIcon, ChevronRightIcon, Columns2Icon, MessageCircleIcon, MessagesSquareIcon, PlusIcon } from 'lucide-react'
import { threadTitle } from '../lib/threads.ts'
import { conversationKey, isOpen } from '../lib/workspace.ts'
import { type RowStatus, type TreeNode, buildTree, rowStatus } from '../lib/workspace-tree.ts'
import { useWorkspace } from './workspace.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** Whether a path shows the workspace: `/` or a conversation's `/c/<id>`. */
export const onWorkspace = (path: string) => path === '/' || path.startsWith('/c/')

/** The icon of a conversation's kind: main, a thread or a subagent. */
export function KindIcon({ kind }: { readonly kind: ConversationView['kind'] }) {
  if (kind === 'main') return <MessageCircleIcon aria-hidden />
  return kind === 'subagent' ? <BotIcon aria-hidden /> : <MessagesSquareIcon aria-hidden />
}

/** The sidebar's tree, from the live workspace feed. */
export function useWorkspaceTree() {
  const { conversations } = useWorkspaceFeed()
  return useMemo(() => buildTree(conversations), [conversations])
}

/**
 * What a row does with its conversation: a click shows it in the focused pane (then the URL names it), and Open beside
 * puts it next to the focused pane, going to the workspace first from another page.
 */
export function useRowActions(id: string) {
  const workspace = useWorkspace()
  const navigate = useNavigate()
  const path = useRouterState({ select: (router) => router.location.pathname })
  const key = conversationKey(id)
  return {
    key,
    open: isOpen(workspace.state, key),
    focused: onWorkspace(path) && workspace.state.focused === key,
    showHere: () => workspace.open(key, 'here'),
    openBeside: () => {
      workspace.open(key, 'beside')
      if (!onWorkspace(path)) void navigate({ to: '/c/$conversationId', params: { conversationId: id } })
    },
  }
}

/** Now, in milliseconds, every second while mounted: how long a conversation has been at work. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function Elapsed({ since }: { readonly since: number }) {
  return <Duration ms={useNow() - since} running />
}

/** How long a working conversation has been at it, a spinner for work below it, and a dot for unread replies. */
function RowMarks({ status }: { readonly status: RowStatus }) {
  return (
    <span className="tree-row-marks">
      {status.state === 'working' && status.since !== undefined && <Elapsed since={status.since} />}
      {status.state === 'working' && <span className="thread-busy" aria-label="Working" />}
      {status.state === 'waiting' && <span className="tree-row-waiting" aria-label="Waiting on its subagents" />}
      {status.state === 'idle' && status.below && <span className="tree-row-below" aria-label="Work under it" />}
      {status.unread && <span className="tree-row-unread" aria-label="Unread replies" />}
    </span>
  )
}

/** Closed conversations under a row, folded into "n closed" until asked for. */
function ClosedFold({ nodes }: { readonly nodes: readonly TreeNode[] }) {
  const [open, setOpen] = useState(false)
  if (nodes.length === 0) return null
  return (
    <SidebarMenuSub>
      <SidebarMenuSubItem>
        <button type="button" className="closed-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRightIcon aria-hidden />
          {nodes.length} closed
        </button>
      </SidebarMenuSubItem>
      {open && nodes.map((node) => <TreeRow key={node.view.id} node={node} nested />)}
    </SidebarMenuSub>
  )
}

/**
 * One conversation, then everything under it at any depth. Its row shows it here on a click, opens it beside on the
 * side button, and drags onto a pane to place it there.
 */
function TreeRow({ node, nested = false }: { readonly node: TreeNode; readonly nested?: boolean }) {
  const { activity } = useWorkspaceFeed()
  const status = rowStatus(node, activity)
  const row = useRowActions(node.view.id)
  const name = threadTitle(node.view)
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem
  return (
    <Item className="tree-row" data-open={row.open} data-unread={status.unread}>
      <SidebarMenuButton
        size={nested ? 'sm' : 'default'}
        render={<Link to="/c/$conversationId" params={{ conversationId: node.view.id }} data-drag-item={row.key} />}
        onClick={row.showHere}
        isActive={row.focused}
      >
        <KindIcon kind={node.view.kind} />
        <span className="tree-row-name">{name}</span>
        <RowMarks status={status} />
      </SidebarMenuButton>
      <button
        type="button"
        className="tree-row-beside"
        aria-label={`Open ${name} beside`}
        title="Open beside"
        onClick={row.openBeside}
      >
        <Columns2Icon aria-hidden />
      </button>
      {node.children.length > 0 && (
        <SidebarMenuSub>
          {node.children.map((child) => (
            <TreeRow key={child.view.id} node={child} nested />
          ))}
        </SidebarMenuSub>
      )}
      <ClosedFold nodes={node.closed} />
    </Item>
  )
}

/** Threads that are closed: hidden behind a toggle, still readable. */
function ClosedThreads({ nodes }: { readonly nodes: readonly TreeNode[] }) {
  const [open, setOpen] = useState(false)
  if (nodes.length === 0) return null
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        render={<button type="button" aria-expanded={open} onClick={() => setOpen(!open)} />}
        className="closed-toggle"
      >
        <ChevronRightIcon aria-hidden />
        Closed ({nodes.length})
      </SidebarGroupLabel>
      {open && (
        <SidebarMenu>
          {nodes.map((node) => (
            <TreeRow key={node.view.id} node={node} />
          ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  )
}

/**
 * The conversations: main with its subagents (and theirs, at any depth), then the threads newest first, each with
 * everything under it, then the closed ones. The "+" beside Threads opens a new thread's draft.
 */
export function SidebarTree({ onNew }: { readonly onNew: () => void }) {
  const tree = useWorkspaceTree()
  return (
    <>
      <SidebarGroup>
        <SidebarMenu>{tree.main !== undefined && <TreeRow node={tree.main} />}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <SidebarGroupAction aria-label="New thread" title="New thread" onClick={onNew}>
          <PlusIcon aria-hidden />
        </SidebarGroupAction>
        {tree.threads.length === 0 ? (
          <p className="sidebar-hint">Start one with +, or reply in thread on any message.</p>
        ) : (
          <SidebarMenu>
            {tree.threads.map((node) => (
              <TreeRow key={node.view.id} node={node} />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroup>
      <ClosedThreads nodes={tree.closedThreads} />
    </>
  )
}
