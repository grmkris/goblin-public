// An App as a page of its own (ADR 0020): one pane showing it, its stage filling the pane under the pill. Filling the
// workspace is maximizing that pane; that is what an App asking for fullscreen gets.
import { useEffect, useMemo, useRef } from 'react'
import type { AppView } from '@purrable/contracts'
import { Button } from '@purrable/ui'
import type { ItemKey } from '../../lib/workspace.ts'
import { appNames } from '../../lib/workspace-tree.ts'
import { usePlace } from '../conversation-pane.tsx'
import { PaneHeader } from '../pane-header.tsx'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { useAppHost } from './host.tsx'
import { AppNote, useSlot } from './slot.tsx'

/** Why the App is not on its page: it could not load, or it was unloaded to stay under the cap; and the way back. */
function PageNote({
  app,
  problem,
  onShow,
}: {
  readonly app: AppView
  readonly problem?: string
  readonly onShow: () => void
}) {
  return (
    <div className="app-page-note">
      <AppNote app={app} note={problem === undefined ? 'was unloaded to save memory' : `could not load: ${problem}`}>
        <Button variant="outline" size="sm" onClick={onShow}>
          {problem === undefined ? 'Show' : 'Try again'}
        </Button>
      </AppNote>
    </div>
  )
}

/**
 * The App's pill, and the room its stage fills. Opening the page loads the App; one unloaded later, while its pane was
 * out of sight, waits behind a note rather than loading again on its own.
 */
export function AppPage({ item, id }: { readonly item: ItemKey; readonly id: string }) {
  const workspace = useWorkspace()
  const host = useAppHost()
  const { apps } = useWorkspaceFeed()
  const app = apps.find((candidate) => candidate.id === id)
  const { first, only } = usePlace(item)
  const register = useSlot(`app-page:${id}`)
  const problem = host.problems.get(id)
  const asleep = !host.instances.has(id) && (host.dormant.has(id) || problem !== undefined)
  const { show } = host
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || app === undefined || app.closedAt !== undefined) return
    opened.current = true
    show(app)
  }, [app, show])
  const title = useMemo(() => appNames(apps).get(id), [apps, id]) ?? 'App'
  return (
    <section className="app-pane" aria-label={title}>
      <PaneHeader item={item} title={title} first={first} onClose={only ? undefined : () => workspace.close(item)} />
      {asleep && app !== undefined ? (
        <PageNote app={app} {...(problem === undefined ? {} : { problem })} onShow={() => show(app)} />
      ) : (
        <div ref={register} className="app-page-slot" />
      )}
    </section>
  )
}
