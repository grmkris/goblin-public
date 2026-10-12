// Where an App is shown and how it moves (ADRs 0020, 0053): in its transcript, or as its page (`/a/<id>`, the main
// column, with the chat bar), and back; and what an App asking for a display mode gets. A server's own App has no place
// in a transcript: its page is all it has. Used by its stage's bar and its page's bar.
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { AppView } from '@goblin/contracts'
import { APP_MODES } from '../../lib/host-context.ts'
import { useNavigation } from '../../lib/navigation.ts'

/** The one display mode a server's own App has (ADR 0053): it opens full screen, from the sidebar or its card. */
const PAGE_ONLY: readonly McpUiDisplayMode[] = ['fullscreen']

/** Where an App is shown and how it moves: to its page, or back in its transcript. */
export function useAppPlacement(app: AppView) {
  const navigation = useNavigation()
  const { id } = app
  const paged = navigation.isAppPage(id)
  const modes = app.source.kind === 'mcp' && app.source.entrypoint === true ? PAGE_ONLY : APP_MODES
  const page = () => navigation.openApp(id)
  /** Back in its transcript: the chat it belongs to opens in place of its page. */
  const inline = () => navigation.closeAppPage(id)
  /** What the App asked for: fullscreen is its page; inline is back in its transcript, where it has a place there. */
  const request = (mode: McpUiDisplayMode): McpUiDisplayMode => {
    if (mode === 'fullscreen') {
      if (!paged) page()
      return 'fullscreen'
    }
    if (mode !== 'inline' || !modes.includes('inline')) return paged ? 'fullscreen' : 'inline'
    if (paged) inline()
    return 'inline'
  }
  return { paged, surface: paged ? ('page' as const) : ('inline' as const), modes, page, inline, request }
}
