import { cn } from './cn.ts'
import { formatToken, formatUsd } from './format.ts'

const SIZE = {
  hero: 'text-5xl font-semibold tracking-tight',
  lg: 'text-3xl font-semibold tracking-tight',
  md: 'text-lg font-semibold tracking-tight',
  sm: 'text-sm font-medium',
} as const

/**
 * An exact amount: USD in tabular figures (never monospace), with the token quantity under it when given.
 * "$0.007" is shown as charged, never rounded to a cent. Without `usd` (ETH and other non-dollar tokens), the token
 * quantity is the headline.
 */
export function Amount({
  usd,
  token,
  size = 'md',
  align = 'start',
  className,
}: {
  readonly usd?: string | undefined
  readonly token?: { readonly symbol: string; readonly amount: string }
  readonly size?: keyof typeof SIZE
  readonly align?: 'start' | 'end'
  readonly className?: string
}) {
  return (
    <span className={cn('inline-flex min-w-0 flex-col', align === 'end' && 'items-end text-end', className)}>
      <span className={cn('leading-none tabular-nums', SIZE[size])}>
        {usd !== undefined ? formatUsd(usd) : `${formatToken(token?.amount ?? '0')} ${token?.symbol ?? ''}`}
      </span>
      {usd !== undefined && token !== undefined && (
        <span className="mt-1 text-xs text-muted-foreground tabular-nums">
          {formatToken(token.amount)} {token.symbol}
        </span>
      )}
    </span>
  )
}
