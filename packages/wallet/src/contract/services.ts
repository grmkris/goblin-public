import * as Schema from 'effect/Schema'
import { Address, ChainKey, Text, UsdAmount } from './ids.ts'

/**
 * A paid service the owner allows: an exact HTTPS origin and path, the rails it may be paid over, and a per-call cap.
 * Discovery never adds one; only the owner's approval or the built-in defaults do.
 */
export const ServiceRule = Schema.Struct({
  id: Text(64),
  title: Text(80),
  method: Schema.Literals(['GET', 'POST']),
  /** Exact https URL, no query. */
  url: Text(512),
  rails: Schema.Array(Schema.Literals(['x402', 'mpp'])),
  chains: Schema.Array(ChainKey),
  maxPerCall: UsdAmount,
  /** Short description for the model: what it returns. */
  description: Text(240),
})
export type ServiceRule = typeof ServiceRule.Type

/** A recipient in the owner's address book. A new recipient needs the owner's approval once. */
export const Recipient = Schema.Struct({
  address: Address,
  chain: ChainKey,
  label: Text(80),
  addedAt: Text(40),
})
export type Recipient = typeof Recipient.Type

/** The built-in service rules. Exa search answers x402 on Base and MPP on Tempo (verified 12 Oct, spike S5). */
export const DEFAULT_SERVICES: readonly ServiceRule[] = [
  {
    id: 'exa.search',
    title: 'Exa search',
    method: 'POST',
    url: 'https://api.exa.ai/search',
    rails: ['x402', 'mpp'],
    chains: ['base', 'tempo'],
    maxPerCall: '0.05',
    description:
      'Web search with fresh results. Body: {"query": string, "numResults"?: number, "type"?: "auto"|"fast"}.',
  },
  {
    id: 'exa.contents',
    title: 'Exa page contents',
    method: 'POST',
    url: 'https://api.exa.ai/contents',
    rails: ['x402', 'mpp'],
    chains: ['base', 'tempo'],
    maxPerCall: '0.05',
    description: 'Clean text of pages. Body: {"urls": string[], "text"?: true}.',
  },
]
