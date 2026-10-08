import { Link } from '@tanstack/react-router'
import type { AppView } from '@goblin/contracts'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@goblin/ui'
import { Columns2Icon, LayoutGridIcon } from 'lucide-react'
import { jobTrouble } from '../lib/app-jobs.ts'
import { appKey } from '../lib/workspace.ts'
import { appOrigin, buildTree } from '../lib/workspace-tree.ts'
import { AppTile, useRowActions } from './sidebar-tree.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** Whether an agent app needs the owner: one of its schedules is paused, failing or waiting for them. */
const needsOwner = (app: AppView) => app.source.kind === 'agent' && app.source.jobs.some(jobTrouble)

/** One agent app: a click shows it here, the side button beside, and it drags onto a pane. */
function AgentAppRow({ app }: { readonly app: AppView }) {
  const row = useRowActions(appKey(app.id))
  return (
    <SidebarMenuItem>
      <div className="tree-row" data-open={row.open}>
        <SidebarMenuButton
          size="tree"
          render={<Link to="/a/$appId" params={{ appId: app.id }} data-drag-item={row.key} />}
          onClick={row.showHere}
          isActive={row.focused}
        >
          <AppTile origin={appOrigin(app)} />
          <span className="tree-row-name">{app.title}</span>
          {needsOwner(app) && <span className="tree-row-alert" aria-label="Needs you" />}
        </SidebarMenuButton>
        <button
          type="button"
          className="tree-row-beside"
          aria-label={`Open ${app.title} beside`}
          title="Open beside"
          onClick={row.openBeside}
        >
          <Columns2Icon aria-hidden />
        </button>
      </div>
    </SidebarMenuItem>
  )
}

/**
 * The agent apps with a view (ADR 0021), newest first: they live with the agent, not under a conversation (MCP Apps
 * stay with theirs). The grid button opens the Apps page, which also lists the apps without a view.
 */
export function SidebarApps() {
  const { apps: all } = useWorkspaceFeed()
  const apps = buildTree([], all).agentApps.map(({ app }) => app)
  if (apps.length === 0) return null
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Apps</SidebarGroupLabel>
      <SidebarGroupAction render={<Link to="/apps" aria-label="All apps" title="All apps" />}>
        <LayoutGridIcon aria-hidden />
      </SidebarGroupAction>
      <SidebarMenu>
        {apps.map((app) => (
          <AgentAppRow key={app.id} app={app} />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
