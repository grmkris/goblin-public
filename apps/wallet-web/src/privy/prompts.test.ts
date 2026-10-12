import { BASE } from '@goblin/wallet/chains'
import type { UserOperation } from '@goblin/wallet/contract'
import { prepareAllowance, reviewAllowance } from '@goblin/wallet/delegation'
import {
  approvePaymaster,
  delegatorDigest,
  delegatorTypedData,
  executeBatch,
  reviewOwnerUpgrade,
  UPGRADE_FEE_CEILINGS,
} from '@goblin/wallet/userop'
import { hashTypedData } from 'viem'
import { describe, expect, test } from 'vitest'
import { asFailure, FlowFailure } from './flow.ts'
import { allowancePrompt, upgradePrompt, walletTypedData } from './prompts.ts'

const OWNER = '0x76c70100000000000000000000000000000000aa'
const AGENT = '0xD354C247817d233Ee0abDB9ffcDF356b5E6B274F'
const NOW = 1_800_000_000_000
function failTest(): never {
  throw new Error('Base takes UserOperations')
}

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

  test("the reviewed upgrade reaches the wallet as the DeleGator's typed data, with its gas bound in cents", () => {
    const aa = BASE.aa ?? failTest()
    const op: UserOperation = {
      sender: OWNER,
      nonce: 0n,
      callData: executeBatch([approvePaymaster(BASE, aa.paymaster, 16_319n)]),
      callGasLimit: 275_767n,
      verificationGasLimit: 61_585n,
      preVerificationGas: 104_329n,
      maxFeePerGas: 8_855_000n,
      maxPriorityFeePerGas: 1_265_000n,
      paymaster: aa.paymaster,
      paymasterData: '0x0200',
      signature: '0x',
    }
    // What the Worker sends: the typed data as JSON, bigints as decimal strings.
    const draft: unknown = JSON.parse(
      JSON.stringify(delegatorTypedData(op, BASE, aa.entryPoint), (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    const reviewed = reviewOwnerUpgrade(draft, { chain: BASE, owner: OWNER, feeCeiling: UPGRADE_FEE_CEILINGS.base })
    const params = walletTypedData(reviewed.typedData)
    const { EIP712Domain: domainFields, ...types } = params.types
    expect(domainFields?.map((field) => field.name)).toEqual(['name', 'version', 'chainId', 'verifyingContract'])
    const message = {
      ...params.message,
      nonce: BigInt(String(params.message['nonce'])),
      preVerificationGas: BigInt(String(params.message['preVerificationGas'])),
    }
    const digest = hashTypedData({
      domain: { name: 'EIP7702StatelessDeleGator', version: '1', chainId: BASE.id, verifyingContract: OWNER },
      types,
      primaryType: 'PackedUserOperation',
      message,
    })
    expect(digest).toBe(delegatorDigest(op, BASE, aa.entryPoint))
    expect(upgradePrompt(reviewed.maxFee)).toEqual({
      title: 'Upgrade your account',
      description: 'One-time. Gas of at most $0.02 is paid in USDC from your account.',
      buttonText: 'Upgrade',
    })
    expect(upgradePrompt(3_000_000n).description).toContain('at most $3.00 ')
  })

  test('failures become stable codes: a closed Privy screen is `rejected`, coded errors keep their code', () => {
    expect(asFailure(new Error('User rejected the request.')).code).toBe('rejected')
    expect(asFailure(new Error('allowance_mismatch: the delegation differs')).code).toBe('allowance_mismatch')
    expect(asFailure('boom').code).toBe('failed')
    const own = new FlowFailure({ code: 'no_wallet', message: 'x' })
    expect(asFailure(own)).toBe(own)
  })
})
