import { Meter } from '@goblin/ui'
import { cn } from './cn.ts'
import type { LimitView } from '@goblin/wallet/contract'
import { Amount } from './amount.tsx'
import { ChainBadge } from './chain-badge.tsx'
import { formatUsd, PERIOD_LABEL, timeUntil } from './format.ts'
import { LAYERS, LayerBadge } from './layer.tsx'

const used = (limit: LimitView): number => Number(limit.used ?? '0')
const total = (limit: LimitView): number => Number(limit.limit)

/**
 * One limit: what is left (the largest figure), how much of the period is used, which layer enforces it and what that
 * layer promises. A per-call cap has no period to meter, so it shows the cap alone.
 */
export function LimitMeter({ limit, className }: { readonly limit: LimitView; readonly className?: string }) {
  const metered = limit.period !== 'call' && limit.used !== undefined
  const share = metered && total(limit) > 0 ? Math.min(100, (used(limit) / total(limit)) * 100) : 0
  const nearly = share >= 90
  return (
    <section
      aria-label={`${PERIOD_LABEL[limit.period]} limit, ${LAYERS[limit.layer].name}`}
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h3 className="text-sm font-medium">{PERIOD_LABEL[limit.period]}</h3>
        <LayerBadge layer={limit.layer} />
      </div>
      <div className="flex items-end justify-between gap-3">
        <Amount usd={metered ? (limit.remaining ?? limit.limit) : limit.limit} size="lg" />
        <span className="pb-0.5 text-end text-xs text-muted-foreground">
          {metered ? `left of ${formatUsd(limit.limit)}` : 'at most'}
          {limit.chain !== undefined && (
            <>
              {' '}
              <ChainBadge chain={limit.chain} className="ms-1" />
            </>
          )}
        </span>
      </div>
      {metered && (
        <div className={nearly ? '[&_[data-slot=meter-indicator]]:bg-attention' : undefined}>
          <Meter value={share} min={0} max={100} aria-label={`${formatUsd(limit.used ?? '0')} used`}>
            <span className="sr-only">{`${formatUsd(limit.used ?? '0')} of ${formatUsd(limit.limit)} used`}</span>
          </Meter>
        </div>
      )}
      <p className="text-xs/relaxed text-muted-foreground">
        {metered && (
          <>
            <span className={cn('tabular-nums', nearly && 'text-foreground')}>{formatUsd(limit.used ?? '0')} used</span>
            {limit.periodEndsAt !== undefined && <> · resets {timeUntil(limit.periodEndsAt)}</>}
            <br />
          </>
        )}
        Enforced by {limit.enforcedBy}. {LAYERS[limit.layer].promise}
      </p>
    </section>
  )
}
