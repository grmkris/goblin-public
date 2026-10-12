// How goblin pays for its model (ADR 0047): with the plan's daily Credits, from the owner's Goblin Wallet per call, or
// the Credits first and then the wallet. A call paid from the wallet goes through goblin's own endpoint (the same
// model) or Tempo's MPP proxy. The model pick stays a model; the composer says when a call is paid.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { PayChoice, PayMode, PayRoute } from '@goblin/contracts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Receipt } from '@goblin/ui'
import { CircleAlertIcon, WalletIcon } from 'lucide-react'
import { choosePayMutation, payQuery } from '../agent/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { serversQuery } from '../mcp/queries.ts'
import { connectionAnchor } from './server-card.tsx'

/** One way goblin pays, as the card offers it. */
type Way = { readonly mode: PayMode; readonly title: string; readonly about: string }

const WAYS: readonly Way[] = [
  {
    mode: 'credits-then-wallet',
    title: 'Credits first, then your wallet',
    about: "Your plan's daily Credits pay first. Once they run out, each call is paid from your Goblin Wallet.",
  },
  {
    mode: 'credits',
    title: 'Credits only',
    about: "goblin stops at the day's limit and answers again when the Credits reset at 00:00 UTC.",
  },
  {
    mode: 'wallet',
    title: 'Your wallet only',
    about:
      'Every call is paid from your Goblin Wallet, at most about $0.02 a call. Your Credits are kept for routines.',
  },
]

/** The ways this stage offers: all three while it sells a paid route, else the Credits alone. */
export const waysOf = (pay: PayChoice): readonly Way[] =>
  pay.routes.length === 0 ? WAYS.filter((way) => way.mode === 'credits') : WAYS

const ROUTES: Readonly<Record<PayRoute, { readonly title: string; readonly about: string }>> = {
  goblin: { title: "goblin's own", about: 'The model you picked, paid to goblin.' },
  tempo: { title: 'Tempo', about: "DeepSeek V4.1 Flash through Tempo's MPP proxy." },
}

/** The routes to choose between: only once a way pays from the wallet and the stage sells more than one. */
export const routesOf = (pay: PayChoice): readonly PayRoute[] =>
  pay.mode !== 'credits' && pay.routes.length > 1 ? pay.routes : []

function WalletNote({ ready }: { readonly ready: boolean }) {
  const wallet = (useQuery(serversQuery).data ?? []).find((server) => server.profile?.id === 'wallet')
  if (ready && wallet !== undefined)
    return (
      <Receipt tone="neutral">
        <WalletIcon aria-hidden />
        <span>Paid calls come from {wallet.label}, within the limits you set there.</span>
      </Receipt>
    )
  return (
    <Receipt tone="error">
      <CircleAlertIcon aria-hidden />
      <span>
        {wallet?.status === 'connected'
          ? 'Paying per call needs your Goblin Wallet to allow its payment tool. '
          : 'Paying per call needs your Goblin Wallet. '}
        <Link
          className="cause-link"
          to="/connections"
          hash={wallet === undefined ? '' : connectionAnchor(wallet.connectionId)}
        >
          {wallet?.status === 'connected' ? 'Allow it on Connections' : 'Connect it on Connections'}
        </Link>
      </span>
    </Receipt>
  )
}

/** One radio row: the native input, its title and what it means. */
function Choice({
  name,
  checked,
  title,
  about,
  onChange,
}: {
  readonly name: string
  readonly checked: boolean
  readonly title: string
  readonly about: string
  readonly onChange: () => void
}) {
  return (
    <label className="setting-row pay-choice">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span className="grant-text">
        <span className="grant-name">{title}</span>
        <span className="grant-about">{about}</span>
      </span>
    </label>
  )
}

/**
 * How goblin pays for its model, as choices: the ways the stage sells, the route paid calls take, and whether the wallet
 * can pay now. Settings' card and first-run Start's step both show it. Nothing while the stage sells only Credits.
 */
export function PayModeChoices() {
  const pay = useQuery(payQuery).data
  const choose = useMutation(choosePayMutation)
  if (pay === undefined) return null
  const ways = waysOf(pay)
  if (ways.length < 2) return null
  const routes = routesOf(pay)
  const pick = (change: Partial<{ readonly mode: PayMode; readonly route: PayRoute }>) =>
    choose.mutate({ mode: pay.mode, route: pay.route, ...change })
  return (
    <>
      <fieldset className="pay-choices">
        <legend className="sr-only">How goblin pays for its model</legend>
        {ways.map((way) => (
          <Choice
            key={way.mode}
            name="pay-mode"
            checked={pay.mode === way.mode}
            title={way.title}
            about={way.about}
            onChange={() => pick({ mode: way.mode })}
          />
        ))}
      </fieldset>
      {routes.length > 0 && (
        <fieldset className="pay-choices pay-routes">
          <legend className="grant-group-title">Paid calls go through</legend>
          {routes.map((route) => (
            <Choice
              key={route}
              name="pay-route"
              checked={pay.route === route}
              title={ROUTES[route].title}
              about={ROUTES[route].about}
              onChange={() => pick({ route })}
            />
          ))}
        </fieldset>
      )}
      {pay.mode !== 'credits' && <WalletNote ready={pay.walletReady} />}
      {choose.error !== null && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{messageOf(choose.error, 'change how goblin pays')}</span>
        </Receipt>
      )}
    </>
  )
}

/** The owner's choice of how goblin pays for its model, in Settings. */
export function InferenceCard() {
  const pay = useQuery(payQuery).data
  if (pay === undefined || waysOf(pay).length < 2) return null
  return (
    <Card id="inference">
      <CardHeader>
        <CardTitle>How goblin pays for its model</CardTitle>
        <CardDescription>Your plan&apos;s daily Credits, your Goblin Wallet for each call, or both.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <PayModeChoices />
        </div>
      </CardContent>
    </Card>
  )
}
