/**
 * Balances and allowances, read straight from the chains over public RPC: native gas and the settlement stablecoin
 * of the owner and the agent on Base, Ethereum, Arbitrum and Tempo, and what is left of the owner's on-chain
 * allowance in the ERC20PeriodTransfer enforcer. Read-only; nothing here signs.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import { erc20Balance } from './erc20.ts'
import { formatUnits } from '../amounts/index.ts'
import { ARBITRUM, BASE, ETHEREUM, TEMPO, type Chain } from '../chains/index.ts'
import type { ChainKey } from '../contract/index.ts'
import { toAddress, toHex } from './hex.ts'
import { httpJsonRpc, quantity, type JsonRpc } from './rpc.ts'

const CHAIN_BY_KEY: Readonly<Record<ChainKey, Chain>> = {
  base: BASE,
  ethereum: ETHEREUM,
  arbitrum: ARBITRUM,
  tempo: TEMPO,
}

export const BALANCE_CHAINS: readonly ChainKey[] = ['base', 'ethereum', 'arbitrum', 'tempo']

const ENFORCER = parseAbi([
  'function getAvailableAmount(bytes32 delegationHash, address delegationManager, bytes terms) view returns (uint256 availableAmount, bool isNewPeriod, uint256 currentPeriod)',
])

export interface TokenBalance {
  readonly symbol: string
  readonly address: string
  readonly decimals: number
  /** Base units. */
  readonly raw: bigint
  /** Decimal string in the token's own units. */
  readonly formatted: string
}

export interface AccountBalance {
  readonly address: string
  /** Native gas token; absent on Tempo, which has none (fees are paid in a stablecoin). */
  readonly native?: TokenBalance
  readonly usdc: TokenBalance
}

export interface ChainBalance {
  readonly chain: ChainKey
  readonly owner?: AccountBalance
  readonly agent: AccountBalance
  /** Set when the chain's RPC failed; the other chains still report. */
  readonly error?: string
}

export type RpcFor = (chain: ChainKey) => JsonRpc

const defaultRpc: RpcFor = (chain) => httpJsonRpc(CHAIN_BY_KEY[chain].rpcUrl)

const token = (symbol: string, address: string, decimals: number, raw: bigint): TokenBalance => ({
  symbol,
  address,
  decimals,
  raw,
  formatted: formatUnits(raw, decimals),
})

const accountBalance = async (rpc: JsonRpc, chain: Chain, key: ChainKey, holder: string): Promise<AccountBalance> => {
  const usdcRaw = await erc20Balance(rpc, chain.usdc.address, holder)
  const usdc = token(chain.usdc.symbol, chain.usdc.address, chain.usdc.decimals, usdcRaw)
  if (key === 'tempo') return { address: holder, usdc }
  const native = quantity(await rpc('eth_getBalance', [holder, 'latest']))
  return { address: holder, native: token('ETH', 'native', 18, native), usdc }
}

export interface BalancesInput {
  readonly agent: string
  readonly owner?: string
  readonly chains?: readonly ChainKey[]
  readonly rpcFor?: RpcFor
}

/** Balances of the agent (and the owner, when known) per chain. A failing chain reports an `error`, never throws. */
export const getBalances = (input: BalancesInput): Promise<readonly ChainBalance[]> => {
  const rpcFor = input.rpcFor ?? defaultRpc
  return Promise.all(
    (input.chains ?? BALANCE_CHAINS).map(async (key): Promise<ChainBalance> => {
      const chain = CHAIN_BY_KEY[key]
      const rpc = rpcFor(key)
      try {
        const [agent, owner] = await Promise.all([
          accountBalance(rpc, chain, key, input.agent),
          input.owner === undefined ? undefined : accountBalance(rpc, chain, key, input.owner),
        ])
        return { chain: key, agent, ...(owner === undefined ? {} : { owner }) }
      } catch (error) {
        // expected: one chain's RPC failing is reported on its row and must not hide the other chains.
        const empty = token(chain.usdc.symbol, chain.usdc.address, chain.usdc.decimals, 0n)
        const message = error instanceof Error ? error.message : 'rpc failed'
        return { chain: key, agent: { address: input.agent, usdc: empty }, error: message.slice(0, 160) }
      }
    }),
  )
}

export interface PeriodTerms {
  readonly token: string
  readonly periodAmount: bigint
  readonly periodDuration: bigint
  readonly startDate: bigint
}

/** Decodes the enforcer's 116-byte terms: token (20) | periodAmount (32) | periodDuration (32) | startDate (32). */
export const parsePeriodTerms = (terms: string): PeriodTerms => {
  const body = terms.startsWith('0x') ? terms.slice(2) : terms
  if (body.length !== 116 * 2) throw new TypeError('period terms must be 116 bytes')
  return {
    token: `0x${body.slice(0, 40)}`,
    periodAmount: BigInt(`0x${body.slice(40, 104)}`),
    periodDuration: BigInt(`0x${body.slice(104, 168)}`),
    startDate: BigInt(`0x${body.slice(168, 232)}`),
  }
}

export interface AllowanceState {
  /** What the enforcer will still let the agent pull this period (base units), before the owner's own balance. */
  readonly available: bigint
  readonly periodAmount: bigint
  readonly isNewPeriod: boolean
  readonly currentPeriod: bigint
  /** Unix seconds when the current period ends; undefined before the start date. */
  readonly periodEndsAt?: bigint
}

export interface AllowanceInput {
  readonly chain: ChainKey
  readonly delegationHash: string
  /** The caveat terms the owner signed. */
  readonly terms: string
  readonly rpcFor?: RpcFor
}

/** The remaining on-chain allowance of one delegation, from `ERC20PeriodTransferEnforcer.getAvailableAmount`. */
export const getAllowanceState = async (input: AllowanceInput): Promise<AllowanceState> => {
  const chain = CHAIN_BY_KEY[input.chain]
  const rpc = (input.rpcFor ?? defaultRpc)(input.chain)
  const data = encodeFunctionData({
    abi: ENFORCER,
    functionName: 'getAvailableAmount',
    args: [toHex(input.delegationHash), toAddress(chain.delegation.manager), toHex(input.terms)],
  })
  const result = await rpc('eth_call', [{ to: chain.delegation.enforcers.erc20PeriodTransfer, data }, 'latest'])
  const [available, isNewPeriod, currentPeriod] = decodeFunctionResult({
    abi: ENFORCER,
    functionName: 'getAvailableAmount',
    data: toHex(String(result)),
  })
  const terms = parsePeriodTerms(input.terms)
  return {
    available,
    periodAmount: terms.periodAmount,
    isNewPeriod,
    currentPeriod,
    ...(currentPeriod === 0n ? {} : { periodEndsAt: terms.startDate + currentPeriod * terms.periodDuration }),
  }
}

export { erc20Balance } from './erc20.ts'
export * from './transfer.ts'
export * from './send.ts'
