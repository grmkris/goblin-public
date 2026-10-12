import { cn } from './cn.ts'
import type { ChainKey } from '@goblin/wallet/contract'
import { CHAIN_LABEL } from './format.ts'

/** The chain a thing lives on, as a quiet name with a dot; no brand colours. */
export function ChainBadge({ chain, className }: { readonly chain: ChainKey; readonly className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span aria-hidden className="size-1.5 rounded-full border border-muted-foreground/60" />
      {CHAIN_LABEL[chain]}
    </span>
  )
}
