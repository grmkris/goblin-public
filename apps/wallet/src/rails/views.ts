import { formatUnits } from '@goblin/wallet/amounts'
import { getAllowanceState, getBalances, parsePeriodTerms } from '@goblin/wallet/balances'
import { chainByKey } from '@goblin/wallet/chains'
import type { ChainBalance, LimitView } from '@goblin/wallet/contract'
import type { RailsDeps, StoredAllowance } from './deps.ts'

const NATIVE = '0x0000000000000000000000000000000000000000'

/** Every token balance the wallet shows: gas and the stablecoin, for the agent and for the owner. */
export const balances = async (deps: RailsDeps): Promise<ChainBalance[]> => {
  const profile = await deps.profile()
  const agent = deps.signer?.address ?? profile.agentAddress
  if (agent === undefined) return []
  const rows = await getBalances({
    live: deps.live,
    agent,
    ...(profile.ownerAddress === undefined ? {} : { owner: profile.ownerAddress }),
    rpcFor: deps.rpcFor,
  })
  return rows.flatMap((row) => {
    const holders = [
      { holder: 'agent' as const, account: row.agent },
      ...(row.owner === undefined ? [] : [{ holder: 'owner' as const, account: row.owner }]),
    ]
    return holders.flatMap(({ holder, account }) =>
      [account.native, account.usdc].flatMap((token) =>
        token === undefined
          ? []
          : [
              {
                chain: row.chain,
                symbol: token.symbol,
                token: token.address === 'native' ? NATIVE : token.address,
                decimals: token.decimals,
                balance: token.formatted,
                holder,
                address: account.address,
              },
            ],
      ),
    )
  })
}

const periodOf = (seconds: bigint): LimitView['period'] => {
  if (seconds === 3600n) return 'hour'
  if (seconds === 86_400n) return 'day'
  if (seconds === 604_800n) return 'week'
  return 'total'
}

const limitOf = async (stored: StoredAllowance, deps: RailsDeps): Promise<LimitView> => {
  const state = await getAllowanceState({
    chain: stored.chain,
    delegationHash: stored.delegationHash,
    terms: stored.terms,
    rpcFor: deps.rpcFor,
    live: deps.live,
  })
  const terms = parsePeriodTerms(stored.terms)
  const chain = chainByKey(stored.chain, deps.live)
  return {
    layer: 'onchain',
    period: periodOf(terms.periodDuration),
    limit: formatUnits(state.periodAmount, 6),
    used: formatUnits(state.periodAmount > state.available ? state.periodAmount - state.available : 0n, 6),
    remaining: formatUnits(state.available, 6),
    chain: stored.chain,
    enforcedBy: `${chain.name}, MetaMask ERC20PeriodTransfer enforcer`,
    ...(state.periodEndsAt === undefined
      ? {}
      : { periodEndsAt: new Date(Number(state.periodEndsAt) * 1000).toISOString() }),
  }
}

/** The on-chain allowances, each read from its enforcer. A chain that fails to answer is left out, not guessed. */
export const allowances = async (deps: RailsDeps): Promise<LimitView[]> => {
  const stored = (await deps.allowances?.()) ?? []
  const limits = await Promise.all(
    stored.map((entry) =>
      limitOf(entry, deps).catch(
        // expected: a chain whose RPC fails is left out of the list rather than shown with a guess.
        () => undefined,
      ),
    ),
  )
  return limits.filter((limit) => limit !== undefined)
}
