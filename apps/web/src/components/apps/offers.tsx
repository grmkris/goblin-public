// What an App offers the owner, drawn by the host where the App cannot reach: a link it asked to open (opened only by
// the owner's own click on a real anchor), and the context it shares with the owner's next message.
import { AppWindowIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { Button } from '@purrable/ui'
import { contextPreview } from '../../lib/app-context.ts'
import { useApps } from './provider.tsx'

export function LinkOffer({
  link,
  serverId,
  onDone,
}: {
  readonly link: URL
  readonly serverId: string
  readonly onDone: () => void
}) {
  const path = `${link.pathname === '/' ? '' : link.pathname}${link.search}`
  return (
    <div className="app-offer" role="status">
      <ExternalLinkIcon aria-hidden />
      <span className="truncate" title={link.href}>
        {serverId} wants to open <strong className="font-medium text-foreground">{link.host}</strong>
        {path}
      </span>
      <Button
        size="sm"
        nativeButton={false}
        render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}
        onClick={onDone}
      >
        Open
      </Button>
      <Button variant="ghost" size="sm" onClick={onDone}>
        Dismiss
      </Button>
    </div>
  )
}

/** Above the composer: what the open App will share with the owner's next message, removable before sending. */
export function SharedContextChip() {
  const { session, setContext } = useApps()
  if (session?.context === undefined) return null
  return (
    <div className="app-offer" role="status">
      <AppWindowIcon aria-hidden />
      <span className="truncate" title={session.context}>
        Sharing from {session.selection.serverId}: {contextPreview(session.context)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Don't share this with your next message"
        onClick={() => setContext('')}
      >
        <XIcon />
      </Button>
    </div>
  )
}
