// A server goblin supports first-class (ADR 0043) on its Connections card: our words for it, its wallet as its status
// tool reports it (the server's claim), and Allow recommended until its recommended grants are in place.
import type { ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ServerProfile, ServerView, ToolView, WalletStatus } from '@goblin/contracts'
import { Button, Receipt } from '@goblin/ui'
import { CircleAlertIcon, WalletIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import { allowRecommendedMutation, serverStatusQuery } from '../mcp/queries.ts'

const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

/** When a wallet's period ends, as a day; nothing for a date that does not read. */
const endsOn = (at: string | undefined): string | undefined =>
  at === undefined || Number.isNaN(Date.parse(at)) ? undefined : day.format(Date.parse(at))

/** Whether the recommended grants are in place: every listed free tool allowed, every listed paid one asking first. */
export const recommendedApplied = (profile: ServerProfile, tools: readonly ToolView[]): boolean => {
  const listed = new Map(tools.map((tool) => [tool.name, tool]))
  const run = profile.recommended.run.flatMap((name) => listed.get(name) ?? [])
  const ask = profile.recommended.ask.flatMap((name) => listed.get(name) ?? [])
  return run.every((tool) => tool.granted) && ask.every((tool) => tool.granted && tool.askFirst)
}

/** The wallet in one line: each token's balance and what its limit has left, and when the period ends. */
export function WalletLine({ wallet, children }: { readonly wallet: WalletStatus; readonly children?: ReactNode }) {
  const ends = endsOn(wallet.periodEndsAt)
  const tokens = wallet.tokens.map((token) =>
    [
      token.balance === undefined ? token.symbol : `${token.balance} ${token.symbol}`,
      token.remaining === undefined
        ? undefined
        : `${token.remaining} left${ends === undefined ? '' : ` until ${ends}`}`,
    ]
      .filter((part) => part !== undefined)
      .join(', '),
  )
  return (
    <Receipt tone={wallet.funding === 'blocked' ? 'error' : 'neutral'}>
      {wallet.funding === 'blocked' ? <CircleAlertIcon aria-hidden /> : <WalletIcon aria-hidden />}
      <span className="tabular-nums">
        {wallet.funding === 'blocked'
          ? 'Wallet: needs funds before paid work can run.'
          : `Wallet: ${tokens.length === 0 ? 'no balance read' : tokens.join(' · ')}`}{' '}
        {children}
      </span>
    </Receipt>
  )
}

/** A first-class server's part of its card, once it is connected. */
export function FirstClassPart({
  server,
  profile,
  tools,
}: {
  readonly server: ServerView
  readonly profile: ServerProfile
  readonly tools: readonly ToolView[] | undefined
}) {
  const status = useQuery(serverStatusQuery(server.connectionId, server.status === 'connected'))
  const allow = useMutation(allowRecommendedMutation)
  const applied = tools !== undefined && recommendedApplied(profile, tools)
  return (
    <section className="server-part" aria-label={profile.title}>
      {status.data != null && <WalletLine wallet={status.data} />}
      {profile.app !== undefined && applied && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          nativeButton={false}
          render={<Link to="/connections/$connectionId/app" params={{ connectionId: server.connectionId }} />}
        >
          Open {profile.title}
        </Button>
      )}
      {!applied && (
        <div className="setting-row">
          <span className="grant-text">
            <span className="grant-name">Allow recommended</span>
            <span className="grant-about">
              Its free tools run when needed; {profile.recommended.ask.join(', ')} asks you first, every time, until you
              change it below.
            </span>
          </span>
          <Button
            size="sm"
            pending={allow.isPending}
            disabled={tools === undefined}
            onClick={() => allow.mutate(server.connectionId)}
          >
            Allow
          </Button>
        </div>
      )}
      {allow.error !== null && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{messageOf(allow.error, 'allow the recommended tools')}</span>
        </Receipt>
      )}
    </section>
  )
}
