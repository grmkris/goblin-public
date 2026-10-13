// What a subscription asks its owner to sign, in the Goblin Wallet's own words and look: who asks, the price and its
// period, then the four terms the chain enforces (what may move, to whom, how much, until when), each ticked, and a
// line on how it ends. A picture of the real thing for a marketing page: it signs nothing.
import type { ReactNode } from 'react'
import { CheckIcon, Link2Icon } from 'lucide-react'

export interface PermissionTerm {
  readonly title: string
  readonly detail: string
}

export interface PermissionCardProps {
  /** Who asks: the plan and its merchant ("goblin Pro"). */
  readonly title: string
  /** Where the ask comes from ("Asked by goblin.surf"). */
  readonly asker?: string
  /** The price as signed, in dollars and cents without the sign ("15.00"). */
  readonly amountUsd: string
  /** Its period, after the price ("every 30 days"). */
  readonly per: string
  readonly terms: readonly PermissionTerm[]
  /** Under the terms: how it ends, where it is cancelled. */
  readonly footer?: ReactNode
}

/** The figure: dollars large and the cents beside them smaller, in tabular figures, read out as one amount. */
function Price({ amountUsd }: { readonly amountUsd: string }) {
  const [whole = '0', cents = ''] = amountUsd.split('.')
  const fraction = cents.padEnd(2, '0').slice(0, 2)
  return (
    <span role="img" aria-label={`$${whole}.${fraction}`} className="permission-card-figure">
      <span aria-hidden>${whole}</span>
      <small aria-hidden>.{fraction}</small>
    </span>
  )
}

export function PermissionCard({ title, asker, amountUsd, per, terms, footer }: PermissionCardProps) {
  return (
    <figure data-slot="permission-card" className="permission-card">
      <div className="permission-card-head">
        <p className="permission-card-title">
          {title}
          <span className="permission-card-chain">
            <Link2Icon aria-hidden />
            Enforced on-chain
          </span>
        </p>
        <p className="permission-card-price">
          <Price amountUsd={amountUsd} />
          {per}
        </p>
        {asker === undefined ? null : <p className="permission-card-asker">{asker}</p>}
      </div>
      <figcaption className="sr-only">What you sign</figcaption>
      <ul className="permission-card-terms">
        {terms.map((term) => (
          <li key={term.title}>
            <span aria-hidden className="permission-card-tick">
              <CheckIcon />
            </span>
            <span className="permission-card-term">
              <b>{term.title}</b>
              <span>{term.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {footer === undefined ? null : <div className="permission-card-foot">{footer}</div>}
    </figure>
  )
}
