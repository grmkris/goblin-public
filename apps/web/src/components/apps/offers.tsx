// What an App offers the owner, drawn by the host where the App cannot reach: a link it asked to open (opened only by
// the owner's own click on a real anchor), and the context it shares with the owner's next message.
import { AppWindowIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { Button } from '@goblin/ui'
import { contextPreview } from '../../lib/app-context.ts'
import { useAppHost } from './host.tsx'

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

/** What the conversation's live Apps share with the owner's next message there: who shares it, and the text. */
export function useSharedContext(conversation: string) {
  const host = useAppHost()
  const shared = [...host.instances.values()].filter(
    (instance) => instance.app.conversation === conversation && instance.context !== undefined,
  )
  return {
    shared,
    /** The context to send, as the message carries it. */
    context: shared.map((instance) => ({ serverId: instance.selection.serverId, text: instance.context ?? '' })),
    /** Sent: each App's context goes with that one message only. */
    clear: () => {
      for (const instance of shared) host.setContext(instance.app.id, '')
    },
    drop: (id: string) => host.setContext(id, ''),
  }
}

/** Above the composer: what the conversation's Apps will share with the owner's next message, removable before. */
export function SharedContextChips({ conversation }: { readonly conversation: string }) {
  const { shared, drop } = useSharedContext(conversation)
  return shared.map((instance) => (
    <div key={instance.app.id} className="app-offer" role="status">
      <AppWindowIcon aria-hidden />
      <span className="truncate" title={instance.context}>
        Sharing from {instance.app.title}: {contextPreview(instance.context ?? '')}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Don't share this with your next message"
        onClick={() => drop(instance.app.id)}
      >
        <XIcon />
      </Button>
    </div>
  ))
}
