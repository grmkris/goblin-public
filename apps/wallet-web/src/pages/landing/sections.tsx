// The landing's quiet half: what each claim in the hero rests on, one visual each. Every figure here is the wallet's
// own (its default limits, the gas ADR 0050 measured on Base mainnet, the four terms of ADR 0054's subscription).
import { PermissionCard } from '@goblin/ui'
import type { SubscriptionView } from '@goblin/wallet/contract'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { CopyButton } from '../../ui/index.ts'
import { billingTail, planName, termsOf } from '../subscription-model.ts'
import { claudeCodeCommand } from './origins.ts'

/** What the paymaster took in USDC for real sends on Base mainnet, 12 October 2026 (ADR 0050). No ETH in any. */
const GAS: readonly { readonly what: string; readonly usdc: string }[] = [
  { what: 'Upgrading your account, signed in the browser', usdc: '0.0038' },
  { what: "Your agent's transfer, topped up from your allowance in the same send", usdc: '0.0073' },
  { what: "A new agent's first send, then a paid web search", usdc: '0.0098' },
]

export function GasVisual() {
  return (
    <figure className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-border border-y border-border">
        {GAS.map((row) => (
          <li key={row.usdc} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-4">
            <span className="site-small text-pretty">{row.what}</span>
            <span className="text-2xl font-semibold tracking-tight tabular-nums">
              {row.usdc}
              <span className="ms-1.5 text-sm font-medium tracking-normal text-muted-foreground">USDC</span>
            </span>
          </li>
        ))}
      </ul>
      <figcaption className="text-13 text-muted-foreground text-pretty">
        Gas for real sends on Base mainnet, 12 October 2026. None of them used ETH.
      </figcaption>
    </figure>
  )
}

/** goblin Pro's day pass, as a request waiting to be signed: the example the four terms are read from. */
const PRO_DAY_PASS: SubscriptionView = {
  id: `sub_${'0'.repeat(32)}`,
  merchant: 'goblin',
  merchantHost: 'goblin.surf',
  plan: 'pro',
  billing: 'day',
  amountUsd: '1.00',
  periodDays: 1,
  months: 12,
  chain: 'base',
  collector: `0x${'0'.repeat(40)}`,
  status: 'pending',
  returnUrl: 'https://goblin.surf/',
  requestExpiresAt: new Date(0).toISOString(),
}

export function SubscriptionVisual() {
  const view = PRO_DAY_PASS
  return (
    <PermissionCard
      title={planName(view)}
      asker={`Asked by ${view.merchantHost}`}
      amountUsd={view.amountUsd}
      per={billingTail(view)}
      terms={termsOf(view)}
      footer={`The chain enforces every term, whatever ${view.merchant} does. You can cancel any time in your wallet.`}
    />
  )
}

/** One line to copy: the text in tabular, wrapping only where it must, with its Copy beside it. */
function CopyLine({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-13 text-muted-foreground">{label}</span>
      <div className="flex items-start gap-2 rounded-xl bg-muted py-2 ps-3.5 pe-2">
        <code className="min-w-0 flex-1 py-1 font-mono text-13/relaxed [overflow-wrap:anywhere] select-all">
          {text}
        </code>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} compact />
      </div>
    </div>
  )
}

export function ConnectVisual({ endpoint }: { readonly endpoint: string }) {
  return (
    <div className="flex flex-col gap-5">
      <CopyLine label="The wallet's MCP address" text={endpoint} />
      <CopyLine label="In Claude Code" text={claudeCodeCommand(endpoint)} />
      <p className="site-small text-muted-foreground">
        Then run <code className="font-mono text-13 text-foreground">/mcp</code>, choose goblin-wallet and sign in. The
        wallet asks you to approve the connection, and your agent gets{' '}
        <code className="font-mono text-13">paid_fetch</code>, <code className="font-mono text-13">transfer</code> and
        the rest, each inside your limits.
      </p>
    </div>
  )
}

/** Each claim checked against ADRs 0045 and 0050. */
const KEYS: readonly { readonly id: string; readonly claim: ReactNode }[] = [
  {
    id: 'account',
    claim:
      'Your account is your own Privy wallet. You sign its upgrade, your allowance and every subscription yourself, in your browser.',
  },
  {
    id: 'address',
    claim: (
      <>
        Your address stays the same: <span className="whitespace-nowrap">EIP-7702</span> upgrades it in place to
        MetaMask’s delegator.
      </>
    ),
  },
  {
    id: 'agent',
    claim:
      'Your agent pays from a wallet of its own, held to a signer policy that refuses key export and anything outside its rules.',
  },
  {
    id: 'signing',
    claim:
      'Nothing signs arbitrary data. Every signature belongs to one payment, its terms fixed before anything is signed.',
  },
]

export function KeysVisual() {
  return (
    <ul className="flex flex-col divide-y divide-border border-y border-border">
      {KEYS.map(({ id, claim }) => (
        <li key={id} className="grid grid-cols-[1.25rem_1fr] gap-3 py-4">
          <Check aria-hidden className="mbs-0.5 size-4 text-moss" strokeWidth={2.25} />
          <span className="site-small text-pretty">{claim}</span>
        </li>
      ))}
    </ul>
  )
}
