import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { type ConversationView, MAIN_THREAD } from '@purrable/contracts'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@purrable/ui'
import {
  BotIcon,
  CatIcon,
  ChevronRightIcon,
  LogOutIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react'
import { signOut } from '../lib/session.tsx'
import { type ThreadNode, isClosed, threadTitle, threadTree } from '../lib/threads.ts'
import { activityState } from '../lib/workspace-feed.ts'
import { useWorkspaceFeed } from './workspace-feed.tsx'
import { useAccountWorkspaces } from '../lib/account-workspaces.tsx'

/** The conversation a path shows: main at `/`, a thread or subagent at `/t/:id`, none elsewhere. */
function conversationAt(path: string): string | undefined {
  if (path === '/') return MAIN_THREAD
  return /^\/t\/([^/]+)/u.exec(path)?.[1]
}

const linkTo = (view: ConversationView) =>
  view.id === MAIN_THREAD ? (
    <Link to="/" />
  ) : view.kind === 'thread' && !isClosed(view) ? (
    <Link to="/" search={{ thread: Number(view.id) }} />
  ) : (
    <Link to="/t/$threadId" params={{ threadId: view.id }} />
  )

/** A spinner while the conversation works, or waits on its subagents. */
function Busy({ view }: { readonly view: ConversationView }) {
  const feed = useWorkspaceFeed()
  if (activityState(feed, view.id) === 'idle') return null
  return (
    <SidebarMenuBadge>
      <span className="thread-busy" aria-label="Working" />
    </SidebarMenuBadge>
  )
}

/** A conversation, with the subagents it started nested under it. */
function ConversationItem({ node, current }: { readonly node: ThreadNode; readonly current: string | undefined }) {
  const { thread } = node
  const Icon = thread.kind === 'main' ? MessageCircleIcon : MessagesSquareIcon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={linkTo(thread)} isActive={thread.id === current}>
        <Icon aria-hidden />
        <span>{threadTitle(thread)}</span>
      </SidebarMenuButton>
      <Busy view={thread} />
      {node.subagents.length > 0 && (
        <SidebarMenuSub>
          {node.subagents.map((subagent) => (
            <SidebarMenuSubItem key={subagent.id}>
              <SidebarMenuSubButton render={linkTo(subagent)} isActive={subagent.id === current}>
                <BotIcon aria-hidden />
                <span>{threadTitle(subagent)}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

/** Threads the owner closed: hidden behind a toggle, still readable. */
function ClosedGroup({
  views,
  current,
}: {
  readonly views: readonly ConversationView[]
  readonly current: string | undefined
}) {
  const [open, setOpen] = useState(false)
  if (views.length === 0) return null
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        render={<button type="button" aria-expanded={open} onClick={() => setOpen(!open)} />}
        className="closed-toggle"
      >
        <ChevronRightIcon aria-hidden />
        Closed ({views.length})
      </SidebarGroupLabel>
      {open && (
        <SidebarMenu>
          {views.map((view) => (
            <ConversationItem key={view.id} node={{ thread: view, subagents: [] }} current={current} />
          ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  )
}

/**
 * Main, then the threads newest first (each with its subagents), then the closed ones. The "+" beside Threads opens
 * a new thread's draft beside main; nothing exists until its first message is sent.
 */
function Conversations({ current, onNew }: { readonly current: string | undefined; readonly onNew: () => void }) {
  const { conversations } = useWorkspaceFeed()
  const tree = useMemo(() => threadTree(conversations), [conversations])
  return (
    <>
      <SidebarGroup>
        <SidebarMenu>{tree.main !== undefined && <ConversationItem node={tree.main} current={current} />}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <SidebarGroupAction
          render={<Link to="/" search={{ new: true }} />}
          aria-label="New thread"
          title="New thread"
          onClick={onNew}
        >
          <PlusIcon aria-hidden />
        </SidebarGroupAction>
        {tree.threads.length === 0 ? (
          <p className="sidebar-hint">
            Start one with +, or reply in thread on any message to talk it through on the side.
          </p>
        ) : (
          <SidebarMenu>
            {tree.threads.map((node) => (
              <ConversationItem key={node.thread.id} node={node} current={current} />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroup>
      <ClosedGroup views={tree.closed} current={current} />
    </>
  )
}

/**
 * The app's navigation: the brand on top, the conversations, then Connections, Settings and Sign out. On phones it is a
 * sheet that closes as soon as the page changes (or a new thread's draft opens beside main, which stays on `/`).
 */
export function AppSidebar() {
  const path = useRouterState({ select: (router) => router.location.pathname })
  const { setOpenMobile } = useSidebar()
  const { state } = useAccountWorkspaces()
  const close = useCallback(() => setOpenMobile(false), [setOpenMobile])
  useEffect(() => close(), [path, close])
  return (
    <Sidebar label="Purrable">
      <SidebarHeader>
        <Link to="/" className="sidebar-brand" aria-label="Purrable home">
          <CatIcon aria-hidden />
          Purrable
        </Link>
        {state?.active && (
          <a href="/settings" className="px-2 text-sm text-muted-foreground">
            {state.active.name} · {state.active.role}
            <span className="block text-xs">Owned by {state.active.ownerName}</span>
          </a>
        )}
      </SidebarHeader>
      <SidebarContent>
        {state?.active?.agentReady && <Conversations current={conversationAt(path)} onNew={close} />}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/connections" />} isActive={path === '/connections'}>
              <PlugIcon aria-hidden />
              <span>Connections</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/settings" />} isActive={path === '/settings'}>
              <SettingsIcon aria-hidden />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => void signOut()}>
              <LogOutIcon aria-hidden />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
