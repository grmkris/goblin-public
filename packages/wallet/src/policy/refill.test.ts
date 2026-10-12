/**
 * The Tempo float's refill (ADR 0051) under the agent policy as it stands: every call of its UserOperation's batch must
 * meet an ALLOW rule, as Privy checks each inner call of the DeleGator's `execute`. The evaluator below reads only the
 * condition kinds the policy uses (transaction fields, calldata by ABI); it is our reading of Privy's rules, not Privy.
 */
import { decodeFunctionData, encodeFunctionData, parseAbi, type Abi } from 'viem'
import { toHex } from '../balances/hex.ts'
import { describe, expect, test } from 'vitest'
import type { TopUp } from '../balances/transfer.ts'
import { executeBridge, FLOAT_MAX_BRIDGE, quoteBridge } from '../bridge/index.ts'
import recorded from '../bridge/fixtures/base-tempo.json' with { type: 'json' }
import { fakeBundler, fakeNode, localAgent } from '../bundler/testing.ts'
import { ARBITRUM, BASE, ETHEREUM, TEMPO } from '../chains/index.ts'
import type { Call } from '../userop/index.ts'
import { AGENT_ROUTES, agentPolicy, PAYMENT_CAP_UNITS, type PolicyCondition, type PolicyRule } from './index.ts'

const signer = localAgent()
const AGENT = signer.address
const fixture: typeof recorded = JSON.parse(
  JSON.stringify(recorded).replaceAll(/03582783c8e71b0c2D3b607E0FBdec7402f76F77/giu, AGENT.slice(2).toLowerCase()),
)
const POLICY = agentPolicy({ ownerId: 'admin', chains: [BASE, ETHEREUM, ARBITRUM, TEMPO], routes: AGENT_ROUTES })
const REDEEM = parseAbi(['function redeemDelegations(bytes[] contexts, bytes32[] modes, bytes[] executions)'])

const same = (a: unknown, b: unknown): boolean => String(a).toLowerCase() === String(b).toLowerCase()

/** One calldata condition: `function_name`, or `<function>.<parameter>` decoded with the rule's ABI. */
const calldataHolds = (condition: PolicyCondition, call: Call): boolean => {
  try {
    // SAFETY: the policy's calldata conditions carry viem-shaped ABI fragments (`fn` in ./index.ts).
    const decoded = decodeFunctionData({ abi: condition.abi as Abi, data: toHex(call.callData) })
    if (condition.field === 'function_name') return decoded.functionName === condition.value
    const [name, parameter] = condition.field.split('.')
    // SAFETY: as above; the first fragment is the function the condition names.
    const inputs = (condition.abi as readonly { inputs: readonly { name: string }[] }[])[0]?.inputs ?? []
    const value = decoded.args?.[inputs.findIndex((input) => input.name === parameter)]
    if (decoded.functionName !== name) return false
    return condition.operator === 'lte'
      ? BigInt(String(value)) <= BigInt(String(condition.value))
      : same(value, condition.value)
  } catch {
    // expected: calldata of another function does not decode under this rule's ABI, so the rule does not hold.
    return false
  }
}

const holds = (condition: PolicyCondition, call: Call, chainId: number): boolean => {
  if (condition.field_source === 'ethereum_calldata') return calldataHolds(condition, call)
  if (condition.field_source !== 'ethereum_transaction') return false
  if (condition.field === 'chain_id') return condition.value === String(chainId)
  if (condition.field === 'to') return same(call.target, condition.value)
  if (condition.field === 'value') return call.value <= BigInt(String(condition.value))
  return false
}

const allowedBy = (call: Call, chainId = BASE.id): PolicyRule | undefined =>
  POLICY.rules.find(
    (rule) =>
      rule.action === 'ALLOW' &&
      rule.method === 'eth_signUserOperation' &&
      rule.conditions.every((condition) => holds(condition, call, chainId)),
  )

/** The refill's batch as the bundler received it: Base USDC to the agent's own Tempo address, drawn from the allowance. */
const refillBatch = async (): Promise<readonly Call[]> => {
  const bridge = await quoteBridge({
    from: 'base',
    to: 'tempo',
    token: 'USDC',
    amount: '2',
    agent: AGENT,
    fetchFn: async () => Response.json(fixture),
  })
  const topUp: TopUp = {
    redeemCalldata: () => encodeFunctionData({ abi: REDEEM, functionName: 'redeemDelegations', args: [[], [], []] }),
    available: async () => 20_000_000n,
  }
  const bundler = fakeBundler()
  await executeBridge({
    bridge,
    live: true,
    agent: signer,
    rpc: fakeNode({ usdc: () => 0n }),
    bundler: bundler.rpc,
    topUp,
    operationKey: 'float:policy-check',
    wait: { sleep: async () => undefined, attempts: 2 },
    fetchFn: async () => Response.json({ status: 'success', txHashes: [] }),
    sleep: async () => undefined,
  })
  return bundler.batches[0] ?? []
}

describe('the refill under the current agent policy', () => {
  test('every call of the batch meets a rule: redeem, Relay approval, Relay deposit, paymaster approval', async () => {
    const batch = await refillBatch()
    expect(batch.map((call) => allowedBy(call)?.name)).toEqual([
      'Redeem allowance userOp on 8453',
      'USDC approve Relay userOp on 8453',
      'Relay call userOp on 8453',
      'USDC approve paymaster userOp on 8453',
    ])
  })

  test('the largest refill fits the route cap; a bigger approval or another spender meets no rule', async () => {
    expect(FLOAT_MAX_BRIDGE).toBeLessThanOrEqual(PAYMENT_CAP_UNITS)
    const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
    const approve = (spender: string, amount: bigint): Call => ({
      target: BASE.usdc.address,
      value: 0n,
      // SAFETY: test addresses are 0x-prefixed 20-byte hex.
      callData: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender as `0x${string}`, amount] }),
    })
    const relay = AGENT_ROUTES.find((route) => route.name === 'Relay')?.address ?? ''
    expect(allowedBy(approve(relay, FLOAT_MAX_BRIDGE))?.name).toBe('USDC approve Relay userOp on 8453')
    expect(allowedBy(approve(relay, PAYMENT_CAP_UNITS + 1n))).toBeUndefined()
    expect(allowedBy(approve(`0x${'77'.repeat(20)}`, 1_000_000n))).toBeUndefined()
    expect(allowedBy(approve(relay, 1_000_000n), 84532)).toBeUndefined()
  })
})
