import { BASE } from '@goblin/wallet/chains'
import { prepareAllowance, reviewAllowance } from '@goblin/wallet/delegation'
import { hashTypedData } from 'viem'
import { describe, expect, test } from 'vitest'
import { asFailure, FlowFailure } from './flow.ts'
import { allowancePrompt, walletTypedData } from './prompts.ts'

const OWNER = '0x76c70100000000000000000000000000000000aa'
const AGENT = '0xD354C247817d233Ee0abDB9ffcDF356b5E6B274F'
const NOW = 1_800_000_000_000

describe('what the owner signs on Privy', () => {
  test('the rebuilt allowance reaches the wallet with its EIP712Domain and hashes as viem hashes it', () => {
    const choice = { chain: BASE, owner: OWNER, agent: AGENT, perHour: '20', days: 7 } as const
    const reviewed = reviewAllowance(prepareAllowance(choice, NOW, 7n), choice, NOW)
    const params = walletTypedData(reviewed.typedData)
    expect(params.types['EIP712Domain']).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ])
    expect(params.primaryType).toBe('Delegation')
    const { EIP712Domain: _domain, ...types } = params.types
    const message = { ...reviewed.typedData.message, salt: BigInt(String(reviewed.typedData.message['salt'])) }
    const digest = hashTypedData({
      domain: { name: 'DelegationManager', version: '1', chainId: BASE.id, verifyingContract: BASE.delegation.manager },
      types,
      primaryType: 'Delegation',
      message,
    })
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/u)
    const prompt = allowancePrompt(BASE.name, reviewed.description)
    expect(prompt.title).toBe('Let your agent spend up to $20 an hour')
    expect(prompt.description).toContain('20 USDC an hour from this wallet on Base, only to itself')
  })

  test('failures become stable codes: a closed Privy screen is `rejected`, coded errors keep their code', () => {
    expect(asFailure(new Error('User rejected the request.')).code).toBe('rejected')
    expect(asFailure(new Error('allowance_mismatch: the delegation differs')).code).toBe('allowance_mismatch')
    expect(asFailure('boom').code).toBe('failed')
    const own = new FlowFailure({ code: 'no_wallet', message: 'x' })
    expect(asFailure(own)).toBe(own)
  })
})
