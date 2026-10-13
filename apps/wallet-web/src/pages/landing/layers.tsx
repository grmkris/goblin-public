// "Every limit says who enforces it": the wallet's own vocabulary of layers (ui/layer.tsx), drawn nested, because each
// layer can only narrow the one around it (ADR 0045). A payment sits at the centre and passes through all of them.
// Tempo's access key is the chain's own layer there; until it lands, the signer and the ledger hold Tempo spends.
import type { LimitLayer } from '@goblin/wallet/contract'
import { DEFAULT_GRANT_DAYS, DEFAULT_LIMITS } from '@goblin/wallet/contract'
import type { CSSProperties, ReactNode } from 'react'
import { formatUsd, LAYERS } from '../../ui/index.ts'
import { priceOf } from '../subscription-model.ts'

/** Outermost first: what each layer holds by default, in the wallet's own figures. */
const NEST: readonly { readonly layer: LimitLayer; readonly holds: string }[] = [
  {
    layer: 'onchain',
    holds: `By default you sign ${priceOf(DEFAULT_LIMITS.perHour)} an hour for ${String(DEFAULT_GRANT_DAYS)} days.`,
  },
  { layer: 'signer', holds: `At most ${priceOf(DEFAULT_LIMITS.perCall)} a payment, to allowed contracts only.` },
  {
    layer: 'ledger',
    holds: `${priceOf(DEFAULT_LIMITS.perCall)} a payment, ${priceOf(DEFAULT_LIMITS.perHour)} an hour, ${priceOf(DEFAULT_LIMITS.perWeek)} a week; anyone new asks you first.`,
  },
  { layer: 'client', holds: "goblin's spending rule, for one, never widens the wallet's." },
]

function Frame({ index, children }: { readonly index: number; readonly children: ReactNode }) {
  const entry = NEST[index]
  if (entry === undefined) return children
  const { name, promise, icon: Icon } = LAYERS[entry.layer]
  // How deep the frame sits sets its corner (landing.css); how many frames hold it sets its tint.
  const place: CSSProperties & Record<'--layer-depth' | '--layer-step', number> = {
    '--layer-depth': NEST.length - index,
    '--layer-step': index,
  }
  return (
    <div className="landing-layer flex flex-col gap-3" style={place}>
      <div className="flex flex-col gap-1 px-1 pt-0.5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon aria-hidden className="size-4 shrink-0 text-moss" strokeWidth={1.75} />
          {name}
        </span>
        <span className="text-13/snug text-muted-foreground text-pretty">
          {promise} {entry.holds}
        </span>
      </div>
      <Frame index={index + 1}>{children}</Frame>
    </div>
  )
}

export function LayersVisual() {
  const tempo = LAYERS.tempo
  return (
    <figure className="landing-layers flex flex-col gap-4">
      <Frame index={0}>
        <div className="landing-layer-core flex items-center justify-between gap-3 bg-card px-3 py-2.5 shadow-(--shadow-1)">
          <span className="text-sm font-medium">Web search, Exa</span>
          <span className="text-sm font-semibold tabular-nums">{formatUsd('0.007')}</span>
        </div>
      </Frame>
      <figcaption className="flex gap-2.5 px-1 text-13/snug text-muted-foreground text-pretty">
        <tempo.icon aria-hidden className="mbs-0.5 size-4 shrink-0" strokeWidth={1.75} />
        <span>
          <span className="font-medium text-foreground">{tempo.name}.</span> On Tempo, the protocol's own spending limit
          takes the chain's place. Until it lands, the signer policy and the ledger hold Tempo payments.
        </span>
      </figcaption>
    </figure>
  )
}
