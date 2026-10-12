// Offers to connect a first-class server the owner has not signed in to (ADR 0043), such as Mercator, which every
// account starts with: in Activity until they connect it or say Not now in this browser.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ServerView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { PlugIcon, WalletIcon } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { modelQuery } from '../agent/queries.ts'
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

/** The key the offer to choose how goblin pays is put off under, beside the connections' own. */
const PAY_OFFER = 'inference'

/**
 * The first-class servers the owner has not signed in to and has not put off, whether to offer choosing how goblin
 * pays for its model (ADR 0047: while the stage sells paid calls and none is picked), how many rows that is, and how
 * to put one off.
 */
export function useConnectOffers(): {
  readonly offers: readonly ServerView[]
  readonly pay: boolean
  readonly count: number
  readonly hide: (id: string) => void
} {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const servers = useQuery(serversQuery).data ?? []
  const choice = useQuery(modelQuery).data
  const offers = unconnectedProfiles(servers).filter(
    (server) => !hidden.has(server.connectionId) && !dismissed(server.connectionId),
  )
  const pay =
    choice !== undefined &&
    choice.options.some((option) => option.id.startsWith('paid:')) &&
    !choice.current.startsWith('paid:') &&
    !hidden.has(PAY_OFFER) &&
    !dismissed(PAY_OFFER)
  return {
    offers,
    pay,
    count: offers.length + (pay ? 1 : 0),
    hide: (id) => setHidden((current) => new Set([...current, id])),
  }
}

/** The offer to choose how goblin pays for its model: Settings has the choice. */
function PayOfferRow({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <li className="list-row" data-static>
      <RowContents
        mark={<WalletIcon aria-hidden />}
        title="Choose how goblin pays for its model"
        meta="Your plan's Credits, or pay for each call from your Goblin Wallet."
        end={
          <span className="row-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                dismiss(PAY_OFFER)
                onDismiss()
              }}
            >
              Not now
            </Button>
            <Button size="sm" nativeButton={false} render={<Link to="/settings" hash="inference" />}>
              Choose
            </Button>
          </span>
        }
      />
    </li>
  )
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
  if (connects.count === 0) return null
  return (
    <PageSection id="connect" title="Get started">
      <ul className="list-rows">
        {connects.pay && <PayOfferRow onDismiss={() => connects.hide(PAY_OFFER)} />}
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
