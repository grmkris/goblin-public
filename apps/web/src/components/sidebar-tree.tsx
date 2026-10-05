import { type CSSProperties, useMemo, useState } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
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
import { AppWindowIcon, ChevronRightIcon, Columns2Icon, PlusIcon } from 'lucide-react'
import { isClosed, threadTitle } from '../lib/threads.ts'
import { type ItemKey, appKey, conversationKey, isOpen, itemOf } from '../lib/workspace.ts'
import {
  type AppRow,
  type RowStatus,
  type TreeNode,
  appHue,
  buildTree,
  foldApps,
  rowStatus,
} from '../lib/workspace-tree.ts'
import { KindMark } from './pane-nav.tsx'
import { useNow } from './use-now.ts'
import { useWorkspace } from './workspace.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** Whether a path shows the workspace: `/`, a conversation's `/c/<id>` or an App's `/a/<id>`. */
export const onWorkspace = (path: string) => path === '/' || path.startsWith('/c/') || path.startsWith('/a/')

/** The sidebar's tree, from the live workspace feed; a thread nobody wrote in shows only while it is in a pane. */
export function useWorkspaceTree() {
  const { conversations, apps } = useWorkspaceFeed()
  const { state } = useWorkspace()
  return useMemo(
    () => buildTree(conversations, apps, (id) => isOpen(state, conversationKey(id))),
    [conversations, apps, state],
  )
}

/** An App's tile: its window icon on a square of its server's own hue. */
export function AppTile({ serverId }: { readonly serverId: string }) {
  const hue: CSSProperties & Record<'--hue', number> = { '--hue': appHue(serverId) }
  return (
    <span className="app-tile" style={hue} aria-hidden>
      <AppWindowIcon />
    </span>
  )
}

/**
 * What a row does with its conversation or App: a click shows it in the focused pane (then the URL names it), and Open
 * beside puts it next to the focused pane, going to the workspace first from another page.
 */
export function useRowActions(key: ItemKey) {
  const workspace = useWorkspace()
  const navigate = useNavigate()
  const path = useRouterState({ select: (router) => router.location.pathname })
  return {
    key,
    open: isOpen(workspace.state, key),
    focused: onWorkspace(path) && workspace.state.focused === key,
    showHere: () => workspace.open(key, 'here'),
    openBeside: () => {
      workspace.open(key, 'beside')
      const item = itemOf(key)
      if (onWorkspace(path) || item === undefined || item.kind === 'draft') return
      if (item.kind === 'app') void navigate({ to: '/a/$appId', params: { appId: item.id } })
      else void navigate({ to: '/c/$conversationId', params: { conversationId: item.id } })
    },
  }
}

function Elapsed({ since }: { readonly since: number }) {
  return <Duration ms={useNow() - since} running />
}

/**
 * How long a working conversation has been at it, a spinner for work below it, and a dot for unread replies. A
 * subagent's own state is its mark at the row's start (`stated`), so the end does not repeat it.
 */
function RowMarks({ status, stated }: { readonly status: RowStatus; readonly stated: boolean }) {
  return (
    <span className="tree-row-marks">
      {status.state === 'working' && status.since !== undefined && <Elapsed since={status.since} />}
      {!stated && status.state === 'working' && <span className="thread-busy" aria-label="Working" />}
      {!stated && status.state === 'waiting' && (
        <span className="tree-row-waiting" aria-label="Waiting on its subagents" />
      )}
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

/** One of a conversation's Apps: a click shows its page here, the side button beside, and it drags onto a pane. */
function AppItem({ row: { app, name } }: { readonly row: AppRow }) {
  const row = useRowActions(appKey(app.id))
  return (
    <SidebarMenuSubItem>
      <div className="tree-row" data-open={row.open}>
        <SidebarMenuButton
          size="sm"
          render={<Link to="/a/$appId" params={{ appId: app.id }} data-drag-item={row.key} />}
          onClick={row.showHere}
          isActive={row.focused}
        >
          <AppTile serverId={app.serverId} />
          <span className="tree-row-name">{name}</span>
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
      </div>
    </SidebarMenuSubItem>
  )
}

/** A conversation's older Apps, folded into "n more apps" until asked for. */
function MoreApps({ rows }: { readonly rows: readonly AppRow[] }) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return (
    <>
      <SidebarMenuSubItem>
        <button type="button" className="closed-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRightIcon aria-hidden />
          {rows.length} more {rows.length === 1 ? 'app' : 'apps'}
        </button>
      </SidebarMenuSubItem>
      {open && rows.map((row) => <AppItem key={row.app.id} row={row} />)}
    </>
  )
}

/**
 * One conversation, then its Apps (those open as pages and the newest few; older ones folded) and everything under it
 * at any depth. Its row shows it here on a click, opens it beside on the
 * side button, and drags onto a pane to place it there.
 */
function TreeRow({ node, nested = false }: { readonly node: TreeNode; readonly nested?: boolean }) {
  const { activity } = useWorkspaceFeed()
  const status = rowStatus(node, activity)
  const row = useRowActions(conversationKey(node.view.id))
  const { state } = useWorkspace()
  const apps = foldApps(node.apps, (id) => isOpen(state, appKey(id)))
  const name = threadTitle(node.view)
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem
  return (
    <Item className="tree-row" data-open={row.open} data-unread={status.unread} data-closed={isClosed(node.view)}>
      <SidebarMenuButton
        size={nested ? 'sm' : 'default'}
        render={<Link to="/c/$conversationId" params={{ conversationId: node.view.id }} data-drag-item={row.key} />}
        onClick={row.showHere}
        isActive={row.focused}
      >
        <KindMark view={node.view} />
        <span className="tree-row-name">{name}</span>
        <RowMarks status={status} stated={node.view.kind === 'subagent'} />
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
      {node.children.length + node.apps.length > 0 && (
        <SidebarMenuSub>
          {apps.shown.map((app) => (
            <AppItem key={app.app.id} row={app} />
          ))}
          <MoreApps rows={apps.folded} />
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
