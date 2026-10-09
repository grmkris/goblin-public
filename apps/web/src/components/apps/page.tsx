// An App as a page of its own (ADR 0020): one pane showing it, its stage filling the pane under the pill. Filling the
// workspace is maximizing that pane; that is what an App asking for fullscreen gets.
import { useEffect, useMemo, useRef } from 'react'
import type { AppView } from '@goblin/contracts'
import { Button, DropdownMenuItem, DropdownMenuSeparator } from '@goblin/ui'
import { Maximize2Icon, MessageSquareIcon, Minimize2Icon, PanelLeftCloseIcon, XIcon } from 'lucide-react'
import { useNavigation } from '../../lib/navigation.ts'
import { type ItemKey, dockOf } from '../../lib/workspace.ts'
import { appNames, appOrigin, isUnread } from '../../lib/workspace-tree.ts'
import { usePlace } from '../conversation-pane.tsx'
import { PaneHeader } from '../pane-header.tsx'
import { AppTile } from '../sidebar-tree.tsx'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { useAppHost } from './host.tsx'
import { useAppPlacement } from './placement.ts'
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
 * The page's pill menu: back in its conversation, full screen with its conversation docked beside it (ADR 0021) and
 * back, and close.
 */
function AppPageMenu({ app }: { readonly app: AppView }) {
  const host = useAppHost()
  const place = useAppPlacement(app)
  return (
    <>
      <DropdownMenuItem onClick={place.inline}>
        <PanelLeftCloseIcon aria-hidden />
        Back in the conversation
      </DropdownMenuItem>
      <DropdownMenuItem onClick={place.fill}>
        {place.filled ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
        {place.filled ? 'Show all panes' : 'Full screen with the chat'}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => host.close(app.id)}>
        <XIcon aria-hidden />
        Close the app
      </DropdownMenuItem>
    </>
  )
}

/** While the App fills the workspace: shows or folds its docked chat, with a dot when it has unread replies. */
function DockToggle({ app }: { readonly app: AppView }) {
  const workspace = useWorkspace()
  const { conversations } = useWorkspaceFeed()
  const { open } = dockOf(workspace.state)
  const view = conversations.find((each) => each.id === app.conversation)
  return (
    <span className="dock-toggle" data-unread={!open && view !== undefined && isUnread(view)}>
      <Button size="sm" variant="ghost" aria-pressed={open} onClick={() => workspace.setDock({ open: !open })}>
        <MessageSquareIcon aria-hidden />
        {open ? 'Hide chat' : 'Chat'}
      </Button>
    </span>
  )
}

/**
 * The App's pill, with what can be done with the App, and the room its stage fills. Opening the page loads the App; one unloaded later, while its pane was
 * out of sight, waits behind a note rather than loading again on its own.
 */
export function AppPage({ item, id }: { readonly item: ItemKey; readonly id: string }) {
  const workspace = useWorkspace()
  const navigation = useNavigation()
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
      <PaneHeader
        item={item}
        title={title}
        first={first}
        {...(app !== undefined && {
          menu: <AppPageMenu app={app} />,
          mark: <AppTile origin={appOrigin(app)} />,
          status: (
            <>
              <span className="pane-state">{appOrigin(app)}</span>
              {workspace.state.maximized === item && workspace.state.docked !== undefined && <DockToggle app={app} />}
            </>
          ),
        })}
        onClose={only ? undefined : () => navigation.closeAppPage(id)}
      />
      {asleep && app !== undefined ? (
        <PageNote app={app} {...(problem === undefined ? {} : { problem })} onShow={() => show(app)} />
      ) : (
        <div ref={register} className="app-page-slot" />
      )}
    </section>
  )
}
