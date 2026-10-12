// What an App offers the owner, drawn by the host where the App cannot reach: a link it asked to open (opened only by
// the owner's own click on a real anchor), a file to save (the same), and the context it shares with the owner's next
// message.
import { useEffect, useState } from 'react'
import { AppWindowIcon, DownloadIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { MAX_APP_CONTEXT } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { contextPreview } from '../../lib/app-context.ts'
import type { DownloadFile } from '../../lib/app-download.ts'
import { useConnectionLabels } from '../../mcp/hooks.ts'
import { useAppHost } from './host.tsx'
import { useConversation } from '../../lib/workspace/hooks.ts'

export function LinkOffer({
  link,
  connectionId,
  onDone,
}: {
  readonly link: URL
  readonly connectionId: string
  readonly onDone: () => void
}) {
  const path = `${link.pathname === '/' ? '' : link.pathname}${link.search}`
  const connection = useConnectionLabels()(connectionId)
  return (
    <div className="app-offer" role="status">
      <ExternalLinkIcon aria-hidden />
      <span className="truncate" title={link.href}>
        {connection} wants to open <strong className="font-medium text-foreground">{link.host}</strong>
        {path}
      </span>
      <Button
        size="app-action"
        nativeButton={false}
        render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}
        onClick={onDone}
      >
        Open
      </Button>
      <Button variant="ghost" size="app-action" onClick={onDone}>
        Dismiss
      </Button>
    </div>
  )
}

/** A file the App offers to save: the owner's click saves it; nothing is saved without one. */
export function DownloadOffer({
  file,
  from,
  onDone,
}: {
  readonly file: DownloadFile
  readonly from: string
  readonly onDone: () => void
}) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    // SAFETY: a fresh Uint8Array owns a plain ArrayBuffer, which is what a Blob part needs.
    const made = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }))
    // oxlint-disable-next-line react/set-state-in-effect -- an object URL is a browser resource made and revoked with its file
    setUrl(made)
    // The browser reads the file after the click, so the URL outlives the offer by a minute.
    return () => void window.setTimeout(() => URL.revokeObjectURL(made), 60_000)
  }, [file])
  return (
    <div className="app-offer" role="status">
      <DownloadIcon aria-hidden />
      <span className="truncate" title={file.name}>
        {from} offers <strong className="font-medium text-foreground">{file.name}</strong> (
        {Math.max(1, Math.round(file.bytes.byteLength / 1024))} KB)
      </span>
      <Button
        size="app-action"
        nativeButton={false}
        disabled={url === undefined}
        render={<a href={url} download={file.name} />}
        // The offer goes once the click has started the download: a link gone mid-click saves nothing.
        onClick={() => void window.setTimeout(onDone, 0)}
      >
        Save
      </Button>
      <Button variant="ghost" size="app-action" onClick={onDone}>
        Dismiss
      </Button>
    </div>
  )
}

/** What the conversation's live Apps share with the owner's next message there: who shares it, and the text. */
/**
 * The Apps in `conversation` that have context to share, and the ones the next message carries: at most
 * `MAX_APP_CONTEXT`, the newest (a fourth paid-call receipt would otherwise make the message unsendable). Send clears
 * all of them.
 */
export function sharedOf<T extends { readonly app: { readonly conversation: string }; readonly context?: string }>(
  instances: Iterable<T>,
  conversation: string,
): { readonly offering: readonly T[]; readonly shared: readonly T[] } {
  const offering = [...instances].filter(
    (instance) => instance.app.conversation === conversation && instance.context !== undefined,
  )
  return { offering, shared: offering.slice(-MAX_APP_CONTEXT) }
}

export function useSharedContext(conversation: string) {
  const host = useAppHost()
  const { offering, shared } = sharedOf(host.instances.values(), conversation)
  return {
    shared,
    /** The context to send, by App id: the runtime finds where each App comes from. */
    context: shared.map(({ app, context }) => ({ app: app.id, text: context ?? '' })),
    /** Sent: each App's context goes with that one message only. */
    clear: () => {
      for (const instance of offering) host.setContext(instance.app.id, '')
    },
    drop: (id: string) => host.setContext(id, ''),
  }
}

/** Above the composer: what the conversation's Apps will share with the owner's next message, removable before. */
export function SharedContextChips({ conversation }: { readonly conversation: string }) {
  const { shared, drop } = useSharedContext(conversation)
  const view = useConversation(conversation)
  const destination = conversation === '1' ? '' : ` to ${view?.title ?? 'Thread'}`
  return shared.map((instance) => (
    <div key={instance.app.id} className="app-offer" role="status">
      <AppWindowIcon aria-hidden />
      <span className="truncate" title={instance.context}>
        Sharing from {instance.app.title}
        {destination}: {contextPreview(instance.context ?? '')}
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
