// A server goblin supports first-class (ADR 0043) on its Connections card: its wallet as its status tool reports it (the
// server's claim), how goblin tops up a prepaid one from the Goblin Wallet (ADR 0049), Review recommended access until
// those grants are in place, then the rule for its paid tool.
import { type ReactNode, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ServerProfile, ServerView, ToolView, WalletStatus } from '@goblin/contracts'
import { Button, Receipt } from '@goblin/ui'
import { CircleAlertIcon, WalletIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import {
  allowRecommendedMutation,
  serverStatusQuery,
  setSpendingMutation,
  setTopUpMutation,
  spendingQuery,
  topUpQuery,
} from '../mcp/queries.ts'

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
 * An amount at a glance, cut down and never rounded up: two decimals from 1 up ("10.15"), four significant digits
 * below it ("0.006375"), so a positive amount never reads as zero.
 */
export function compactAmount(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.')
  if (/[1-9]/u.test(whole)) {
    const cents = fraction.slice(0, 2).replace(/0+$/u, '')
    return cents === '' ? whole : `${whole}.${cents}`
  }
  const first = fraction.search(/[1-9]/u)
  return first === -1 ? '0' : `0.${fraction.slice(0, first + 4).replace(/0+$/u, '')}`
}

/**
 * The wallet's status tool in one line: each token's balance at a glance, then what its limit has left and until when,
 * said once when every token shares it.
 */
export function walletSummary(wallet: WalletStatus, ends: string | undefined): string {
  if (wallet.tokens.length === 0) return 'no balance read'
  const until = ends === undefined ? '' : ` until ${ends}`
  const left = (remaining: string) => `${compactAmount(remaining)} left${until}`
  const shared = new Set(wallet.tokens.map((token) => token.remaining))
  const once = shared.size === 1 ? [...shared][0] : undefined
  const tokens = wallet.tokens.map((token) =>
    [
      token.balance === undefined ? token.symbol : `${compactAmount(token.balance)} ${token.symbol}`,
      once === undefined && token.remaining !== undefined ? left(token.remaining) : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(', '),
  )
  return `${tokens.join(' · ')}${once === undefined ? '' : `; ${left(once)}`}`
}

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
  const summary = walletSummary(wallet, endsOn(wallet.periodEndsAt))
  return (
    <Receipt tone={wallet.funding === 'blocked' ? 'error' : 'neutral'}>
      {wallet.funding === 'blocked' ? <CircleAlertIcon aria-hidden /> : <WalletIcon aria-hidden />}
      <span className="tabular-nums">
        {wallet.funding === 'blocked' ? 'Wallet: needs funds before paid work can run.' : `Wallet: ${summary}`}{' '}
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

/** The recommended set as the owner reviews it: the tools the server lists now, by title, in each policy. */
export function recommendedList(
  profile: ServerProfile,
  tools: readonly ToolView[],
): { readonly run: readonly string[]; readonly ask: readonly string[] } {
  const listed = new Map(tools.map((tool) => [tool.name, tool]))
  const titles = (names: readonly string[]) =>
    names.flatMap((name) => {
      const tool = listed.get(name)
      return tool === undefined ? [] : [tool.title ?? name]
    })
  return { run: titles(profile.recommended.run), ask: titles(profile.recommended.ask) }
}

/**
 * Review recommended access: what it allows, listed exactly, before one Allow. Free tools run when needed; the ones
 * that pay ask first, every time, until the owner changes that below.
 */
function RecommendedReview({
  server,
  profile,
  tools,
}: {
  readonly server: ServerView
  readonly profile: ServerProfile
  readonly tools: readonly ToolView[]
}) {
  const allow = useMutation(allowRecommendedMutation)
  const [open, setOpen] = useState(false)
  const { run, ask } = recommendedList(profile, tools)
  const count = run.length + ask.length
  return (
    <div className="recommended">
      <div className="setting-row">
        <span className="grant-text">
          <span className="grant-name">Recommended access</span>
          <span className="grant-about">
            {run.length} tools run when needed; {ask.length} ask you first, every time.
          </span>
        </span>
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Review'}
        </Button>
      </div>
      {open && (
        <div className="recommended-review">
          <p className="recommended-head">Run without asking</p>
          <ul className="recommended-list">
            {run.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
          <p className="recommended-head">Ask you first, every time</p>
          <ul className="recommended-list">
            {ask.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
          <Button
            size="sm"
            className="self-start"
            pending={allow.isPending}
            onClick={() => allow.mutate(server.connectionId)}
          >
            Allow these {count} tools
          </Button>
        </div>
      )}
      {allow.error !== null && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{messageOf(allow.error, 'allow the recommended tools')}</span>
        </Receipt>
      )}
    </div>
  )
}

/**
 * A first-class server at a glance on its card: its wallet line (the status tool's claim), Open for its App whatever
 * the owner has allowed (opening it as the owner grants the agent nothing), and Review recommended access until it is
 * in place.
 */
export function FirstClassSummary({
  server,
  profile,
  tools,
}: {
  readonly server: ServerView
  readonly profile: ServerProfile
  readonly tools: readonly ToolView[] | undefined
}) {
  const status = useQuery(serverStatusQuery(server.connectionId, server.status === 'connected' && profile.status))
  const applied = tools !== undefined && recommendedApplied(profile, tools)
  return (
    <>
      {status.data != null && <WalletLine wallet={status.data} profile={profile} />}
      {profile.prepaid !== undefined && server.status === 'connected' && (
        <PrepaidLine connectionId={server.connectionId} profile={profile} wallet={status.data} balance={false} />
      )}
      {tools !== undefined && !applied && <RecommendedReview server={server} profile={profile} tools={tools} />}
    </>
  )
}

/** A first-class server's own rule for its paid tool, once its recommended access is in place. */
export function FirstClassAccess({
  server,
  profile,
  tools,
}: {
  readonly server: ServerView
  readonly profile: ServerProfile
  readonly tools: readonly ToolView[] | undefined
}) {
  const applied = tools !== undefined && recommendedApplied(profile, tools)
  if (profile.spend === undefined || !applied) return null
  return <SpendingRule connectionId={server.connectionId} tool={profile.spend.tool} />
}

/** Up to two dollar amounts, as the owner's form takes them: empty, or a plain decimal with at most two places. */
const AMOUNT = /^\d{1,6}(?:\.\d{1,2})?$/u

/** A prepaid server's own balance, in the token it is paid in, as its status line reads; nothing until it is read. */
export const prepaidBalance = (
  prepaid: NonNullable<ServerProfile['prepaid']>,
  wallet: WalletStatus | null | undefined,
): string | undefined => wallet?.tokens.find((token) => token.symbol === prepaid.token)?.balance

/** The top-up rule in the owner's words. */
export const topUpSentence = (rule: { readonly perTopUp: string; readonly daily: string }): string =>
  `goblin tops it up from your Goblin Wallet: up to $${rule.perTopUp} a top-up and $${rule.daily} a day without asking.`

/**
 * A prepaid server's own balance (its status line, when `balance` and read) and how goblin tops it up from the Goblin
 * Wallet (ADR 0049), the profile's default until the owner changes it; Change opens the rule in place. Above the rule,
 * goblin does not move money and the job says what to approve.
 */
export function PrepaidLine({
  connectionId,
  profile,
  wallet,
  balance = true,
}: {
  readonly connectionId: string
  readonly profile: ServerProfile
  readonly wallet?: WalletStatus | null | undefined
  readonly balance?: boolean
}) {
  const view = useQuery(topUpQuery(connectionId)).data
  const save = useMutation(setTopUpMutation)
  const [editing, setEditing] = useState(false)
  const [perTopUp, setPerTopUp] = useState<string>()
  const [daily, setDaily] = useState<string>()
  const prepaid = profile.prepaid
  if (prepaid === undefined) return null
  const rule = view ?? { perTopUp: prepaid.perTopUp, daily: prepaid.daily }
  const each = perTopUp ?? rule.perTopUp
  const day = daily ?? rule.daily
  const valid = AMOUNT.test(each) && AMOUNT.test(day)
  const held = balance ? prepaidBalance(prepaid, wallet) : undefined
  return (
    <div className="prepaid-line">
      <p className="server-note tabular-nums">
        {held === undefined ? '' : `${profile.title} balance $${compactAmount(held)}. `}
        {topUpSentence(rule)}{' '}
        <Button variant="link" size="xs" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {editing ? 'Close' : 'Change'}
        </Button>
      </p>
      {editing && (
        <form
          className="spending-rule-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) save.mutate({ connectionId, perTopUp: each, daily: day }, { onSuccess: () => setEditing(false) })
          }}
        >
          <label>
            Up to $
            <input
              inputMode="decimal"
              value={each}
              aria-invalid={!AMOUNT.test(each)}
              onChange={(event) => setPerTopUp(event.target.value.trim())}
            />
            a top-up
          </label>
          <label>
            $
            <input
              inputMode="decimal"
              value={day}
              aria-invalid={!AMOUNT.test(day)}
              onChange={(event) => setDaily(event.target.value.trim())}
            />
            a day
          </label>
          <Button size="sm" type="submit" disabled={!valid} pending={save.isPending}>
            Save
          </Button>
        </form>
      )}
      {save.error !== null && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{messageOf(save.error, 'change the top-up rule')}</span>
        </Receipt>
      )}
    </div>
  )
}

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
