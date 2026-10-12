// How goblin pays for its model (ADR 0047): with the plan's daily Credits, or per call from the owner's Goblin Wallet,
// through Tempo's MPP proxy or goblin's own paid endpoint. The choice is the model pick, so the composer shows it too.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ModelChoice } from '@goblin/contracts'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Receipt } from '@goblin/ui'
import { CircleAlertIcon, WalletIcon } from 'lucide-react'
import { chooseModelMutation, modelQuery } from '../agent/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { serversQuery } from '../mcp/queries.ts'
import { connectionAnchor } from './server-card.tsx'

/** One way to pay: the model it picks, and what it means for the owner. */
type Way = { readonly model: string; readonly title: string; readonly about: string }

/** The ways this deployment offers: its default model on Credits, then each paid route it sells. */
export const waysOf = (choice: ModelChoice): readonly Way[] => [
  { model: choice.default, title: 'Included in your plan', about: "Your plan's daily model Credits pay for it." },
  ...choice.options.flatMap((option): Way[] =>
    option.id === 'paid:tempo'
      ? [
          {
            model: option.id,
            title: 'Pay per call: Tempo',
            about:
              "DeepSeek V4.1 Flash through Tempo's MPP proxy, paid in USDC.e from your Goblin Wallet for each call, priced from its length (at most about $0.02).",
          },
        ]
      : option.id === 'paid:goblin'
        ? [
            {
              model: option.id,
              title: 'Pay per call: goblin',
              about: "goblin's own model, paid the same way from your Goblin Wallet, with no Credits used.",
            },
          ]
        : [],
  ),
]

/** Whether a pick pays per call from the wallet. */
const paidPick = (model: string): boolean => model.startsWith('paid:')

function WalletNote() {
  const wallet = (useQuery(serversQuery).data ?? []).find((server) => server.profile?.id === 'wallet')
  if (wallet?.status === 'connected')
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
        Paying per call needs your Goblin Wallet.{' '}
        <Link
          className="cause-link"
          to="/connections"
          hash={wallet === undefined ? '' : connectionAnchor(wallet.connectionId)}
        >
          Connect it on Connections
        </Link>
      </span>
    </Receipt>
  )
}

/** The owner's choice of how goblin pays for its model, in Settings and from onboarding. */
export function InferenceCard() {
  const choice = useQuery(modelQuery).data
  const pick = useMutation(chooseModelMutation)
  if (choice === undefined) return null
  const ways = waysOf(choice)
  if (ways.length < 2) return null
  return (
    <Card id="inference">
      <CardHeader>
        <CardTitle>How goblin pays for its model</CardTitle>
        <CardDescription>Use your plan&apos;s Credits, or pay for each call from your Goblin Wallet.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          {ways.map((way) => {
            const current = way.model === choice.current || (way.model === choice.default && !paidPick(choice.current))
            return (
              <div key={way.model} className="setting-row">
                <span className="grant-text">
                  <span className="grant-name">{way.title}</span>
                  <span className="grant-about">{way.about}</span>
                </span>
                <Button
                  size="sm"
                  variant={current ? 'outline' : 'default'}
                  disabled={current}
                  pending={pick.isPending && pick.variables === way.model}
                  onClick={() => pick.mutate(way.model)}
                >
                  {current ? 'In use' : 'Use'}
                </Button>
              </div>
            )
          })}
          {paidPick(choice.current) && <WalletNote />}
          {pick.error !== null && (
            <Receipt tone="error">
              <CircleAlertIcon aria-hidden />
              <span>{messageOf(pick.error, 'change how goblin pays')}</span>
            </Receipt>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
