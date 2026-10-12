// Offers to connect a first-class server the owner has not signed in to (ADR 0043), such as Mercator, which every
// account starts with: in Activity until they connect it or say Not now in this browser.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ServerView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { PlugIcon } from 'lucide-react'
import { useConnectNow } from '../mcp/hooks.ts'
import { serversQuery } from '../mcp/queries.ts'
import { RowContents } from './shell/pages/chat-link.tsx'
import { PageSection } from './page-section.tsx'

const DISMISSED = 'goblin.connect-offer.dismissed:'

/** Whether the owner said Not now to connecting `connectionId` in this browser; a storage that fails remembers nothing. */
const dismissed = (connectionId: string): boolean => {
  try {
    return localStorage.getItem(`${DISMISSED}${connectionId}`) !== null
  } catch {
    // expected: no storage (a private window); the offer simply shows again
    return false
  }
}

const dismiss = (connectionId: string): void => {
  try {
    localStorage.setItem(`${DISMISSED}${connectionId}`, '1')
  } catch {
    // expected: no storage; Not now hides it for this visit only
  }
}

/**
 * The first-class connections worth offering: signed out, while no other connection to the same server (by profile) is
 * signed in, each profile once. A second Mercator connection is not news when the first one works.
 */
export const unconnectedProfiles = (servers: readonly ServerView[]): readonly ServerView[] => {
  const connected = new Set(
    servers.flatMap((server) =>
      server.status === 'connected' && server.profile !== undefined ? [server.profile.id] : [],
    ),
  )
  const seen = new Set<string>()
  return servers.filter((server) => {
    if (server.profile === undefined || server.status === 'connected' || connected.has(server.profile.id)) return false
    if (seen.has(server.profile.id)) return false
    seen.add(server.profile.id)
    return true
  })
}

/** The first-class servers the owner has not signed in to and has not put off, and how to put one off. */
export function useConnectOffers(): { readonly offers: readonly ServerView[]; readonly hide: (id: string) => void } {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const servers = useQuery(serversQuery).data ?? []
  const offers = unconnectedProfiles(servers).filter(
    (server) => !hidden.has(server.connectionId) && !dismissed(server.connectionId),
  )
  return { offers, hide: (id) => setHidden((current) => new Set([...current, id])) }
}

/** One offer: what the server does for goblin, Connect, and Not now. */
export function ConnectOfferRow({
  server,
  onDismiss,
}: {
  readonly server: ServerView
  readonly onDismiss: () => void
}) {
  const connectNow = useConnectNow()
  const [connecting, setConnecting] = useState(false)
  const title = server.profile?.title ?? server.label
  return (
    <li className="list-row" data-static>
      <RowContents
        mark={<PlugIcon aria-hidden />}
        title={`Connect ${title}`}
        meta={server.profile?.description}
        end={
          <span className="row-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                dismiss(server.connectionId)
                onDismiss()
              }}
            >
              Not now
            </Button>
            <Button
              size="sm"
              pending={connecting}
              onClick={() => {
                setConnecting(true)
                const done = () => setConnecting(false)
                void connectNow(server.connectionId).then(done, done)
              }}
            >
              Connect
            </Button>
          </span>
        }
      />
    </li>
  )
}

/** Activity's offers to connect first-class servers, under Get started. */
export function ConnectOffers({ connects }: { readonly connects: ReturnType<typeof useConnectOffers> }) {
  if (connects.offers.length === 0) return null
  return (
    <PageSection id="connect" title="Get started">
      <ul className="list-rows">
        {connects.offers.map((server) => (
          <ConnectOfferRow
            key={server.connectionId}
            server={server}
            onDismiss={() => connects.hide(server.connectionId)}
          />
        ))}
      </ul>
    </PageSection>
  )
}
