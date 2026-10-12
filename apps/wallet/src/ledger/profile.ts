import { Address, ChainSetup } from '@goblin/wallet/contract'
import * as Schema from 'effect/Schema'
import type { Ctx } from './rows.ts'
import { getState, putState } from './state.ts'

/** What the wallet knows of its owner, written by onboarding and read by the MCP server and the owner API. */
export const Profile = Schema.Struct({
  ownerAddress: Schema.optional(Address),
  agentAddress: Schema.optional(Address),
  /** Privy's id of the agent's server wallet. */
  agentWalletId: Schema.optional(Schema.String),
  chains: Schema.Array(ChainSetup),
})
export type Profile = typeof Profile.Type

const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(Profile))

export function readProfile(ctx: Ctx): Profile {
  const raw = getState(ctx, 'profile')
  return raw === undefined ? { chains: [] } : decodeProfile(raw)
}

/** Merges a patch into the profile. `chains` entries replace the ones for the same chain. */
export function updateProfile(ctx: Ctx, patch: Partial<Profile>): Profile {
  const current = readProfile(ctx)
  const incoming = patch.chains ?? []
  const chains = [
    ...current.chains.filter((entry) => !incoming.some((next) => next.chain === entry.chain)),
    ...incoming,
  ]
  const next: Profile = {
    ...current,
    ...(patch.ownerAddress === undefined ? {} : { ownerAddress: patch.ownerAddress }),
    ...(patch.agentAddress === undefined ? {} : { agentAddress: patch.agentAddress }),
    ...(patch.agentWalletId === undefined ? {} : { agentWalletId: patch.agentWalletId }),
    chains,
  }
  putState(ctx, 'profile', JSON.stringify(next))
  return next
}
