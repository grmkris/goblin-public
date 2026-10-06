import type { AppView } from '@goblin/contracts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { useHomeEdit } from './edit.ts'

/** An explicit owner keep: pinning an open MCP App changes only its presentation. */
export function useHomePin(app: AppView) {
  const { home } = useWorkspaceFeed()
  const edit = useHomeEdit()
  const available =
    app.source.kind === 'mcp' &&
    app.closedAt === undefined &&
    home !== undefined &&
    !home.tiles.some((tile) => tile.kind === 'app' && tile.appId === app.id)
  const pin = () =>
    edit.edit([{ kind: 'add', tile: { kind: 'app', appId: app.id, id: `app-home-${app.id}`, size: 'medium' } }])
  return { available, pending: edit.pending, notice: edit.notice, pin }
}
