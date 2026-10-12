// The five layers that can hold a limit, and what each one promises. The wallet's pitch is that the owner sees which
// limit is the chain's and which is only this service's word, so every limit carries its layer.
import type { LimitLayer } from '@goblin/wallet/contract'
import { BookText, KeyRound, Link2, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

interface LayerInfo {
  readonly name: string
  /** What happens if this service misbehaves or is down. */
  readonly promise: string
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>
}

export const LAYERS: Record<LimitLayer, LayerInfo> = {
  onchain: {
    name: 'On-chain allowance',
    promise: 'The chain enforces it, whatever this service does.',
    icon: Link2,
  },
  tempo: {
    name: 'Tempo access key',
    promise: 'The Tempo protocol enforces it, whatever this service does.',
    icon: KeyRound,
  },
  signer: {
    name: 'Signer policy',
    promise: 'The signer refuses to sign past it, whatever this service does.',
    icon: ShieldCheck,
  },
  ledger: {
    name: 'Wallet ledger',
    promise: 'This wallet checks it before every payment.',
    icon: BookText,
  },
  client: {
    name: 'Client rule',
    promise: 'Your MCP client keeps this rule; the wallet only reports it.',
    icon: SlidersHorizontal,
  },
}

export function LayerBadge({ layer }: { readonly layer: LimitLayer }) {
  const { name, icon: Icon } = LAYERS[layer]
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground ring-1 ring-border">
      <Icon aria-hidden className="size-3.5" />
      {name}
    </span>
  )
}
