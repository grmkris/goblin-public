// Where an App is shown and how it moves (ADR 0020): its page beside its transcript, back, filling the workspace from
// its page with its conversation docked beside it (ADR 0021); and what an App asking for a display mode gets. Used by
// its stage's bar and its page's pill.
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { AppView } from '@goblin/contracts'
import { appKey, conversationKey, isOpen, order } from '../../lib/workspace.ts'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { useAppHost } from './host.tsx'

/** Where an App is shown and how it moves: to its page beside its transcript, back, filling the workspace, or not. */
export function useAppPlacement(app: AppView) {
  const workspace = useWorkspace()
  const host = useAppHost()
  const tile = useWorkspaceFeed().home?.tiles.find((each) => each.kind === 'app' && each.appId === app.id)
  const { id, conversation } = app
  const key = appKey(id)
  const paged = isOpen(workspace.state, key)
  const filled = workspace.state.maximized === key
  const page = () => {
    const source = (host.element(`app-home:${id}`) ?? host.element(`app-inline:${id}`))?.closest<HTMLElement>(
      '[data-workspace-item]',
    )?.dataset.workspaceItem
    workspace.open(key, 'beside', source)
  }
  /** Back in its transcript: the page closes, or, as the last pane, shows the App's conversation in its place. */
  const inline = () => {
    if (filled) workspace.maximize(undefined)
    if (order(workspace.state).length > 1) workspace.close(key)
    else workspace.open(conversationKey(tile === undefined ? conversation : '1'), 'here', key)
  }
  const docked = conversationKey(conversation)
  /** Fills the workspace with the App and its conversation docked beside it, or gives the panes back. */
  const fill = () => workspace.maximize(filled ? undefined : key, docked)
  /** What the App asked for: fullscreen is its page filling the workspace; inline is back in its transcript. */
  const request = (mode: McpUiDisplayMode): McpUiDisplayMode => {
    if (mode === 'fullscreen') {
      if (!paged) page()
      workspace.maximize(key, docked)
      return 'fullscreen'
    }
    if (mode !== 'inline') return paged ? 'fullscreen' : 'inline'
    if (paged) inline()
    return 'inline'
  }
  return {
    paged,
    tile,
    surface: paged ? ('page' as const) : tile === undefined ? ('inline' as const) : ('home' as const),
    filled,
    page,
    inline,
    fill,
    request,
  }
}
