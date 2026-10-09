// Where an App is shown and how it moves (ADR 0020): in its transcript, or as its page (`/a/<id>`, the main column),
// and back; and what an App asking for a display mode gets. Used by its stage's bar and its page's bar.
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { AppView } from '@goblin/contracts'
import { useNavigation } from '../../lib/navigation.ts'

/** Where an App is shown and how it moves: to its page, or back in its transcript. */
export function useAppPlacement(app: AppView) {
  const navigation = useNavigation()
  const { id } = app
  const paged = navigation.isAppPage(id)
  const page = () => navigation.openApp(id)
  /** Back in its transcript: the chat it belongs to opens in place of its page. */
  const inline = () => navigation.closeAppPage(id)
  /** What the App asked for: fullscreen is its page; inline is back in its transcript. */
  const request = (mode: McpUiDisplayMode): McpUiDisplayMode => {
    if (mode === 'fullscreen') {
      if (!paged) page()
      return 'fullscreen'
    }
    if (mode !== 'inline') return paged ? 'fullscreen' : 'inline'
    if (paged) inline()
    return 'inline'
  }
  return { paged, surface: paged ? ('page' as const) : ('inline' as const), page, inline, request }
}
