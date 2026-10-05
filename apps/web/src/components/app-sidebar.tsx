import { useCallback, useEffect } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@purrable/ui'
import { CatIcon, LogOutIcon, PlugIcon, SettingsIcon } from 'lucide-react'
import { signOut } from '../lib/session.tsx'
import { useAccountWorkspaces } from '../lib/account-workspaces.tsx'
import { SidebarTree, onWorkspace } from './sidebar-tree.tsx'
import { WorkspaceRail } from './workspace-rail.tsx'
import { useWorkspace } from './workspace.tsx'

/** Connections (the owner's), Settings and Sign out; folded to the rail, their icons alone. */
function Pages({ path, rail, owner }: { readonly path: string; readonly rail: boolean; readonly owner: boolean }) {
  return (
    <SidebarMenu>
      {owner && (
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<Link to="/connections" aria-label="Connections" title={rail ? 'Connections' : undefined} />}
            isActive={path === '/connections'}
          >
            <PlugIcon aria-hidden />
            {!rail && <span>Connections</span>}
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      <SidebarMenuItem>
        <SidebarMenuButton
          render={<Link to="/settings" aria-label="Settings" title={rail ? 'Settings' : undefined} />}
          isActive={path === '/settings'}
        >
          <SettingsIcon aria-hidden />
          {!rail && <span>Settings</span>}
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => void signOut()} aria-label="Sign out" title={rail ? 'Sign out' : undefined}>
          <LogOutIcon aria-hidden />
          {!rail && <span>Sign out</span>}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/**
 * The app's navigation: the brand on top, the conversations, then Connections, Settings and Sign out. On a desktop it
 * folds to an icon rail (never away); on phones it is a sheet that closes as soon as the page changes or a new
 * thread's draft opens.
 */
export function AppSidebar() {
  const path = useRouterState({ select: (router) => router.location.pathname })
  const navigate = useNavigate()
  const { setOpenMobile, state: fold, isMobile } = useSidebar()
  const { state } = useAccountWorkspaces()
  const workspace = useWorkspace()
  const rail = fold === 'collapsed' && !isMobile
  const close = useCallback(() => setOpenMobile(false), [setOpenMobile])
  useEffect(() => close(), [path, close])
  const draft = useCallback(() => {
    workspace.draft(undefined, [], workspace.state.focused)
    close()
    if (!onWorkspace(path)) void navigate({ to: '/' })
  }, [workspace, close, path, navigate])
  const ready = state?.active?.agentReady === true
  return (
    <Sidebar label="Purrable">
      <SidebarHeader>
        <Link to="/" className="sidebar-brand" aria-label="Purrable home">
          <CatIcon aria-hidden />
          {!rail && 'Purrable'}
        </Link>
        {state?.active && !rail && (
          <a href="/settings" className="px-2 text-sm text-muted-foreground">
            {state.active.name} · {state.active.role}
            <span className="block text-xs">Owned by {state.active.ownerName}</span>
          </a>
        )}
      </SidebarHeader>
      <SidebarContent>
        {ready && rail && <WorkspaceRail onNew={draft} />}
        {ready && !rail && <SidebarTree onNew={draft} />}
      </SidebarContent>
      <SidebarFooter>
        <Pages path={path} rail={rail} owner={state?.active?.role === 'owner'} />
        {!rail && (
          <a className="sidebar-credit" href="https://github.com/DanFessler/trellis" target="_blank" rel="noreferrer">
            Workspace layout powered by Trellis by Dan Fessler
          </a>
        )}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
