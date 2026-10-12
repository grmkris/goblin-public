import { cn } from './cn.ts'
import { formatToken, formatTokenCompact, formatUsd, formatUsdCompact } from './format.ts'

const SIZE = {
  hero: 'text-4xl font-semibold tracking-tight',
  lg: 'text-3xl font-semibold tracking-tight',
  md: 'text-lg font-semibold tracking-tight',
  sm: 'text-sm font-medium',
} as const

/**
 * An amount in tabular figures (never monospace), with the token quantity under it when given. By default it is exact,
 * as a charge must be: "$0.007" is never rounded to a cent. `compact` is for balances: cents for dollars, four
 * significant digits for a token, cut down and never to zero, with the exact value under it (or in its title when
 * there is no line under it). Without `usd` (ETH and other non-dollar tokens) the token quantity is the headline.
 */
export function Amount({
  usd,
  token,
  size = 'md',
  align = 'start',
  compact = false,
  className,
}: {
  readonly usd?: string | undefined
  readonly token?: { readonly symbol: string; readonly amount: string }
  readonly size?: keyof typeof SIZE
  readonly align?: 'start' | 'end'
  readonly compact?: boolean
  readonly className?: string
}) {
  const exactToken = token === undefined ? '' : `${formatToken(token.amount)} ${token.symbol}`
  const headline =
    usd === undefined
      ? `${(compact ? formatTokenCompact : formatToken)(token?.amount ?? '0')} ${token?.symbol ?? ''}`
      : (compact ? formatUsdCompact : formatUsd)(usd)
  const exactHeadline = usd === undefined ? exactToken : formatUsd(usd)
  return (
    <span className={cn('inline-flex min-w-0 flex-col', align === 'end' && 'items-end text-end', className)}>
      <span
        className={cn('leading-none tabular-nums', SIZE[size])}
        title={compact && exactHeadline !== headline ? exactHeadline : undefined}
      >
        {headline}
      </span>
      {usd !== undefined && token !== undefined && (
        <span className="mt-1 text-xs text-muted-foreground tabular-nums">{exactToken}</span>
      )}
    </span>
  )
}
