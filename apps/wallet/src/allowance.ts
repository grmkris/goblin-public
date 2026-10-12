import { getAllowanceState, type EvmChain, type JsonRpc, type TopUp } from '@goblin/wallet/balances'
import { chainByKey, type ChainKey } from '@goblin/wallet/chains'
import {
  allowanceRedeemCalldata,
  confirmAllowance,
  prepareAllowance,
  type PreparedAllowance,
  type SignedAllowance,
} from '@goblin/wallet/delegation'
import type { AllowancePort } from './context.ts'
import type { WalletEnv } from './env.ts'
import { ledgerClient } from './ledger/durable.ts'
import type { StoredAllowance } from './rails/index.ts'
import { failure } from './services/errors.ts'

const live = (env: WalletEnv): boolean => env.WALLET_LIVE === '1'
// SAFETY: the contract's Address and Hex schemas checked the `0x` pattern before these reach the delegation code.
const hex = (value: string): `0x${string}` => value as `0x${string}`
const ledgerOf = (env: WalletEnv, userId: string) => ledgerClient(env.LEDGER.getByName(userId))

/** The delegation code throws `code: message`; the owner API answers it as a 400 with that code. */
const refusal = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error)
  const code = /^([a-z_]+):/u.exec(text)?.[1] ?? 'allowance_refused'
  return failure(code, text.slice(code.length + 1).trim() || 'The allowance was refused.', 400)
}

/**
 * The owner's on-chain allowance (ADR 0045): `prepare` builds the exact ERC-7710 delegation (lane S's encoders) and keeps
 * it in the ledger under its hash; `confirm` checks the owner's signature against that draft and stores the signed
 * delegation for its chain, where the rails redeem it from.
 */
export const productionAllowance: AllowancePort = {
  prepare: async (env, owner, request) => {
    const chain = chainByKey(request.chain, live(env))
    let prepared: PreparedAllowance
    try {
      prepared = prepareAllowance(
        { chain, owner: hex(owner.address), agent: hex(owner.agent), perHour: request.perHour, days: request.days },
        Date.now(),
      )
    } catch (error) {
      throw refusal(error)
    }
    await ledgerOf(env, owner.userId).putPreparedAllowance(prepared.delegationHash, JSON.stringify(prepared))
    return { typedData: prepared.typedData, delegationHash: prepared.delegationHash }
  },
  confirm: async (env, owner, request) => {
    const chain = chainByKey(request.chain, live(env))
    const ledger = ledgerOf(env, owner.userId)
    const raw = await ledger.preparedAllowance(request.delegationHash)
    if (raw === undefined)
      throw failure('allowance_unknown', 'Prepare the allowance again; this one is not known.', 409)
    // SAFETY: the ledger only holds what `prepare` above wrote with JSON.stringify of a PreparedAllowance.
    const prepared = JSON.parse(raw) as PreparedAllowance
    let signed: SignedAllowance
    try {
      signed = await confirmAllowance(chain, prepared, hex(owner.address), hex(request.signature))
    } catch (error) {
      throw refusal(error)
    }
    await ledger.putSignedAllowance(request.chain, JSON.stringify(signed))
    return { perHour: signed.perHour, expiresAt: signed.expiresAt, delegationHash: signed.delegationHash }
  },
}

const EVM_CHAINS: readonly string[] = ['base', 'ethereum', 'arbitrum']
const isEvmChain = (chain: string): chain is EvmChain => EVM_CHAINS.includes(chain)

/** The ERC20PeriodTransfer caveat terms of a signed allowance: what the enforcer reports the remainder from. */
const periodTerms = (env: WalletEnv, chain: ChainKey, signed: SignedAllowance): string | undefined => {
  const enforcer = chainByKey(chain, live(env)).delegation.enforcers.erc20PeriodTransfer.toLowerCase()
  return signed.delegation.caveats.find((item) => item.enforcer.toLowerCase() === enforcer)?.terms
}

const signedOf = async (env: WalletEnv, userId: string): Promise<{ chain: ChainKey; signed: SignedAllowance }[]> =>
  (await ledgerOf(env, userId).signedAllowances()).map((row) => ({
    // SAFETY: rows are keyed by the contract's ChainKey and hold what `confirm` above stored.
    chain: row.chain as ChainKey,
    // SAFETY: as above, JSON.stringify of a SignedAllowance.
    signed: JSON.parse(row.json) as SignedAllowance,
  }))

/** What the rails need from the owner's allowances: how the agent tops itself up, and what each one has left. */
export const allowanceRails = (env: WalletEnv, userId: string, rpcFor: (chain: ChainKey) => JsonRpc) => ({
  topUp: async (chain: EvmChain): Promise<TopUp | undefined> => {
    const found = (await signedOf(env, userId)).find((entry) => entry.chain === chain)
    const terms = found === undefined ? undefined : periodTerms(env, chain, found.signed)
    if (found === undefined || terms === undefined) return undefined
    const onChain = chainByKey(chain, live(env))
    return {
      redeemCalldata: (amount: bigint) => allowanceRedeemCalldata(onChain, found.signed.delegation, amount),
      available: async () =>
        (await getAllowanceState({ chain, delegationHash: found.signed.delegationHash, terms, rpcFor })).available,
    }
  },
  allowances: async (): Promise<readonly StoredAllowance[]> =>
    (await signedOf(env, userId)).flatMap(({ chain, signed }) => {
      const terms = periodTerms(env, chain, signed)
      return terms === undefined || !isEvmChain(chain)
        ? []
        : [{ chain, delegationHash: signed.delegationHash, terms, expiresAt: signed.expiresAt }]
    }),
})
