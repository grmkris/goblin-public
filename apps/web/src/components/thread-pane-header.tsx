import { Link } from '@tanstack/react-router'
import { Button, TopBar, TopBarTitle } from '@purrable/ui'
import { Maximize2Icon, XIcon } from 'lucide-react'

export type ThreadHost = 'workspace' | 'sheet'

/** Sheets own their chrome; a workspace pane already has its title and close action in the tab. */
export function ThreadPaneHeader({
  host,
  title,
  thread,
  onClose,
}: {
  readonly host: ThreadHost
  readonly title: string
  readonly thread?: string
  readonly onClose: () => void
}) {
  if (host === 'workspace') return null
  return (
    <TopBar floating>
      <TopBarTitle>{title}</TopBarTitle>
      {thread !== undefined && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open the thread in full"
          nativeButton={false}
          render={<Link to="/t/$threadId" params={{ threadId: thread }} />}
        >
          <Maximize2Icon />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Close the thread" onClick={onClose}>
        <XIcon />
      </Button>
    </TopBar>
  )
}
