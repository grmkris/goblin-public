// A server goblin supports first-class (ADR 0043) on its Connections card: our words for it, its wallet as its status
// tool reports it (the server's claim), and Allow recommended until its recommended grants are in place.
import { type ReactNode, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ServerProfile, ServerView, ToolView, WalletStatus } from '@goblin/contracts'
import { Button, Receipt } from '@goblin/ui'
import { CircleAlertIcon, WalletIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import { allowRecommendedMutation, serverStatusQuery, setSpendingMutation, spendingQuery } from '../mcp/queries.ts'

const dateOf = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

/** When a wallet's period ends, as a day; nothing for a date that does not read. */
const endsOn = (at: string | undefined): string | undefined =>
  at === undefined || Number.isNaN(Date.parse(at)) ? undefined : dateOf.format(Date.parse(at))

/** Whether the recommended grants are in place: every listed free tool allowed, every listed paid one asking first. */
export const recommendedApplied = (profile: ServerProfile, tools: readonly ToolView[]): boolean => {
  const listed = new Map(tools.map((tool) => [tool.name, tool]))
  const run = profile.recommended.run.flatMap((name) => listed.get(name) ?? [])
  const ask = profile.recommended.ask.flatMap((name) => listed.get(name) ?? [])
  return run.every((tool) => tool.granted) && ask.every((tool) => tool.granted && tool.askFirst)
}

/** Where the owner adds funds: the profile's top-up link, while the wallet says it needs funds. */
export const topUpOf = (profile: ServerProfile, wallet: WalletStatus): string | undefined =>
  wallet.funding === 'blocked' && profile.topUp?.url.startsWith('https://') === true ? profile.topUp.url : undefined

/**
 * The wallet in one line: each token's balance and what its limit has left, and when the period ends; while it needs
 * funds, the way to add them.
 */
export function WalletLine({
  wallet,
  profile,
  children,
}: {
  readonly wallet: WalletStatus
  readonly profile: ServerProfile
  readonly children?: ReactNode
}) {
  const topUp = topUpOf(profile, wallet)
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
        {topUp !== undefined && (
          <a className="cause-link" href={topUp} target="_blank" rel="noopener noreferrer">
            Add funds
          </a>
        )}{' '}
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
      {status.data != null && <WalletLine wallet={status.data} profile={profile} />}
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
      {profile.spend !== undefined && applied && (
        <SpendingRule connectionId={server.connectionId} tool={profile.spend.tool} />
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

/** Up to two dollar amounts, as the owner's form takes them: empty, or a plain decimal with at most two places. */
const AMOUNT = /^\d{1,6}(?:\.\d{1,2})?$/u

/**
 * The owner's spending rule for a first-class server's paid tool (ADR 0044): every job asks first, or jobs up to an
 * amount run without asking until the day's total passes a second one. Today's spend is shown beside it; the wallet's
 * own limit stays the hard stop.
 */
export function SpendingRule({ connectionId, tool }: { readonly connectionId: string; readonly tool: string }) {
  const view = useQuery(spendingQuery(connectionId)).data
  const save = useMutation(setSpendingMutation)
  const [perJob, setPerJob] = useState<string>()
  const [daily, setDaily] = useState<string>()
  const job = perJob ?? view?.perJob ?? ''
  const day = daily ?? view?.daily ?? ''
  const valid = AMOUNT.test(job) && (day === '' || AMOUNT.test(day))
  const ruled = view?.perJob !== undefined
  return (
    <div className="spending-rule">
      <p className="server-note tabular-nums">
        {ruled
          ? `${tool}: jobs up to $${view.perJob}${view.daily === undefined ? '' : `, $${view.daily} a day,`} run without asking.`
          : `${tool}: every job asks you first.`}{' '}
        Spent today: ${view?.spentToday ?? '0'}.
      </p>
      <form
        className="spending-rule-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) save.mutate({ connectionId, perJob: job, daily: day === '' ? null : day })
        }}
      >
        <label>
          Up to $
          <input
            inputMode="decimal"
            value={job}
            aria-invalid={job !== '' && !AMOUNT.test(job)}
            onChange={(event) => setPerJob(event.target.value.trim())}
          />
          a job
        </label>
        <label>
          $
          <input
            inputMode="decimal"
            value={day}
            aria-invalid={day !== '' && !AMOUNT.test(day)}
            onChange={(event) => setDaily(event.target.value.trim())}
          />
          a day
        </label>
        <Button size="sm" type="submit" disabled={!valid} pending={save.isPending && save.variables.perJob !== null}>
          Run without asking
        </Button>
        {ruled && (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            pending={save.isPending && save.variables.perJob === null}
            onClick={() => save.mutate({ connectionId, perJob: null, daily: null })}
          >
            Always ask
          </Button>
        )}
      </form>
      {save.error !== null && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{messageOf(save.error, 'change the spending rule')}</span>
        </Receipt>
      )}
    </div>
  )
}
