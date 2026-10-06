// Where an App is shown and how it moves (ADR 0020): its page beside its transcript, back, filling the workspace from
// its page; and what an App asking for a display mode gets. Used by its stage's bar and its page's pill.
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { AppView } from '@goblin/contracts'
import { appKey, conversationKey, isOpen, order } from '../../lib/workspace.ts'
import { useWorkspace } from '../workspace.tsx'
import { useAppHost } from './host.tsx'

/** Where an App is shown and how it moves: to its page beside its transcript, back, filling the workspace, or not. */
export function useAppPlacement(app: AppView) {
  const workspace = useWorkspace()
  const host = useAppHost()
  const { id, conversation } = app
  const key = appKey(id)
  const paged = isOpen(workspace.state, key)
  const filled = workspace.state.maximized === key
  const page = () => {
    const source = host.element(`app-inline:${id}`)?.closest<HTMLElement>('[data-workspace-item]')
      ?.dataset.workspaceItem
    workspace.open(key, 'beside', source)
  }
  /** Back in its transcript: the page closes, or, as the last pane, shows the App's conversation in its place. */
  const inline = () => {
    if (filled) workspace.maximize(undefined)
    if (order(workspace.state).length > 1) workspace.close(key)
    else workspace.open(conversationKey(conversation), 'here', key)
  }
  const fill = () => workspace.maximize(filled ? undefined : key)
  /** What the App asked for: fullscreen is its page filling the workspace; inline is back in its transcript. */
  const request = (mode: McpUiDisplayMode): McpUiDisplayMode => {
    if (mode === 'fullscreen') {
      if (!paged) page()
      workspace.maximize(key)
      return 'fullscreen'
    }
    if (mode !== 'inline') return paged ? 'fullscreen' : 'inline'
    if (paged) inline()
    return 'inline'
  }
  return { paged, filled, page, inline, fill, request }
}
