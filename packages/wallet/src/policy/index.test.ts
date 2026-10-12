import { describe, expect, test } from 'vitest'
import { RELAY_DEPOSITORY } from '../bridge/index.ts'
import { ARBITRUM, BASE, BASE_SEPOLIA, ETHEREUM, TEMPO } from '../chains/index.ts'
import { LIFI_DIAMOND } from '../lifi/index.ts'
import { AGENT_POLICY_NAME, AGENT_ROUTES, PAYMENT_CAP_UNITS, agentPolicy, samePolicy, writablePolicy } from './index.ts'

const ADMIN = 'k6jmz9g665ljwkdpy3c01xhy'
const MAINNETS = [BASE, ETHEREUM, ARBITRUM, TEMPO]

describe('the agent policy', () => {
  test('the mainnet document (snapshot)', () => {
    expect(agentPolicy({ ownerId: ADMIN, chains: MAINNETS, routes: AGENT_ROUTES })).toMatchSnapshot()
  })

  test('names are short and unique; export is denied; every rule is chain-pinned or 7702-to-DeleGator', () => {
    const policy = agentPolicy({ ownerId: ADMIN, chains: MAINNETS })
    const names = policy.rules.map((rule) => rule.name)
    expect(AGENT_POLICY_NAME.length).toBeLessThan(50)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name.length).toBeLessThan(50)
    expect(policy.rules.at(-1)).toEqual({
      name: 'Deny export',
      method: 'exportPrivateKey',
      action: 'DENY',
      conditions: [],
    })
    for (const rule of policy.rules.filter((candidate) => candidate.action === 'ALLOW')) {
      const pinned = rule.conditions.some(
        (condition) => (condition.field === 'chain_id' || condition.field === 'chainId') && condition.operator === 'eq',
      )
      const delegator = rule.conditions.some((condition) => condition.value === BASE.delegation.delegator)
      expect(pinned || delegator, rule.name).toBe(true)
    }
    expect(policy.rules.map((rule) => rule.method).toSorted()).toEqual(
      [
        ...Array.from({ length: 3 }, () => [
          'eth_signTypedData_v4',
          'eth_signUserOperation',
          'eth_signUserOperation',
          'eth_signUserOperation',
        ]).flat(),
        'eth_signTransaction',
        'eth_signTransaction',
        'eth_sign7702Authorization',
        'exportPrivateKey',
      ].toSorted(),
    )
  })

  test('the routes: the LI.FI diamond on Base, the Relay depository on every EVM origin the rails bridge from', () => {
    expect(AGENT_ROUTES.map((route) => `${route.chain.id}:${route.address.toLowerCase()}`)).toEqual([
      `8453:${LIFI_DIAMOND.toLowerCase()}`,
      `8453:${RELAY_DEPOSITORY.toLowerCase()}`,
      `42161:${RELAY_DEPOSITORY.toLowerCase()}`,
      `1:${RELAY_DEPOSITORY.toLowerCase()}`,
    ])
    const names = agentPolicy({ ownerId: ADMIN, chains: MAINNETS, routes: AGENT_ROUTES }).rules.map((rule) => rule.name)
    expect(names).toContain('USDC approve LI.FI userOp on 8453')
    expect(names).toContain('Relay call userOp on 42161')
  })

  test('UserOperations pay their gas through an approval to the paymaster, capped at the chain gas ceiling', () => {
    const rules = agentPolicy({ ownerId: ADMIN, chains: [BASE, ETHEREUM] }).rules
    const paymaster = rules.filter((rule) => rule.name.startsWith('USDC approve paymaster'))
    expect(paymaster.map((rule) => rule.conditions.at(-1)?.value)).toEqual(['0x186a0', '0x2dc6c0'])
    expect(rules.some((rule) => rule.method === 'eth_sendTransaction')).toBe(false)
  })

  test('the transitional form allows the same calls as plain transactions too, and nothing more', () => {
    const both = agentPolicy({ ownerId: ADMIN, chains: [BASE], forms: ['userop', 'transaction'] }).rules
    const plain = both.filter((rule) => rule.method === 'eth_sendTransaction').map((rule) => rule.name)
    expect(plain).toEqual(['Redeem allowance on 8453', 'USDC transfer on 8453'])
  })

  test('caps are the per-payment cap: decimal for typed data, hex for calldata', () => {
    const policy = agentPolicy({ ownerId: ADMIN, chains: [BASE, TEMPO], capUnits: 2_500_000n })
    const caps = policy.rules.flatMap((rule) =>
      rule.conditions.filter((condition) => condition.operator === 'lte').map((condition) => condition.value),
    )
    // The paymaster approval is capped by the gas ceiling (0.10 USDC on Base), not the payment cap.
    expect(caps).toEqual(['2500000', '0x0', '0x0', '0x2625a0', '0x0', '0x186a0', '0x2625a0', '0x2625a0'])
    expect(PAYMENT_CAP_UNITS).toBe(5_000_000n)
  })

  test('the x402 rule is the one the S1 spike proved live, unchanged', () => {
    const [payment] = agentPolicy({ ownerId: ADMIN, chains: [BASE] }).rules
    expect(payment?.name).toBe('USDC payment on 8453')
    expect(payment?.conditions.slice(0, 2)).toEqual([
      { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: '8453' },
      {
        field_source: 'ethereum_typed_data_domain',
        field: 'verifyingContract',
        operator: 'eq',
        value: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
    ])
  })

  test('testnets get their own chain ids and USDC', () => {
    const [payment] = agentPolicy({ ownerId: ADMIN, chains: [BASE_SEPOLIA] }).rules
    expect(payment?.conditions[0]?.value).toBe('84532')
    expect(payment?.conditions[1]?.value).toBe(BASE_SEPOLIA.usdc.address)
  })

  test('a live policy compares by content, ignoring ids and timestamps; unknown fields refuse', () => {
    const desired = agentPolicy({ ownerId: ADMIN, chains: [BASE] })
    const live = {
      id: 'l57oel4tqkttsvzbrv1x00wy',
      created_at: 1_791_773_009_456,
      ...desired,
      rules: desired.rules.map((rule, index) => ({ id: `rule-${index}`, ...rule })),
    }
    expect(samePolicy(writablePolicy(live), desired)).toBe(true)
    expect(samePolicy(writablePolicy({ ...live, name: 'other' }), desired)).toBe(false)
    expect(() => writablePolicy({ ...live, surprise: true })).toThrow('invalid_policy')
  })
})
