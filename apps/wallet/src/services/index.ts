import * as Layer from 'effect/Layer'
import { approvalsLayer, type Approvals } from './approvals.ts'
import { ledgerLayer, type Ledger } from './ledger.ts'
import { railsLayer, type Rails, type RailsPort } from './rails.ts'
import { signerLayer, type Signer } from './signer.ts'
import type { AgentSigner } from '@goblin/wallet/contract'
import type { LedgerApi } from '../ledger/durable.ts'

/** Every service a wallet program may ask for. */
export type WalletServices = Ledger | Signer | Rails | Approvals

export interface WalletParts {
  readonly ledger: LedgerApi
  readonly signer: AgentSigner | undefined
  readonly rails: RailsPort
  /** The Worker's origin, for approval URLs. */
  readonly origin: string
}

export const walletLayer = (parts: WalletParts): Layer.Layer<WalletServices> =>
  Layer.mergeAll(
    ledgerLayer(parts.ledger),
    signerLayer(parts.signer),
    railsLayer(parts.rails),
    approvalsLayer(parts.origin),
  )
