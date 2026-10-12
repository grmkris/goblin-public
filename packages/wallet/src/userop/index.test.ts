import { recoverAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { ARBITRUM, BASE, TEMPO } from '../chains/index.ts'
import type { UserOperation } from '../contract/signer.ts'
import {
  accountGasLimits,
  approvePaymaster,
  decodeBatch,
  delegatorDigest,
  delegatorTypedData,
  executeBatch,
  paymasterAndData,
  reviewOwnerUpgrade,
  toBundlerJson,
  toPrivyJson,
  UPGRADE_FEE_CEILINGS,
} from './index.ts'

const account = privateKeyToAccount(`0x${'42'.repeat(32)}`)
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const PAYMASTER = '0x777777777777AeC03fd955926DbF81597e66834C'

const op: UserOperation = {
  sender: account.address,
  nonce: 3n,
  callData: executeBatch([approvePaymaster(BASE, PAYMASTER, 16_319n)]),
  callGasLimit: 275_767n,
  verificationGasLimit: 61_585n,
  preVerificationGas: 104_329n,
  maxFeePerGas: 8_855_000n,
  maxPriorityFeePerGas: 1_265_000n,
  paymaster: PAYMASTER,
  paymasterVerificationGasLimit: 46_456n,
  paymasterPostOpGasLimit: 43_715n,
  paymasterData: '0x0200',
  signature: '0x',
}

/** The same operation without a paymaster. */
const bare: UserOperation = {
  sender: op.sender,
  nonce: op.nonce,
  callData: op.callData,
  callGasLimit: op.callGasLimit,
  verificationGasLimit: op.verificationGasLimit,
  preVerificationGas: op.preVerificationGas,
  maxFeePerGas: op.maxFeePerGas,
  maxPriorityFeePerGas: op.maxPriorityFeePerGas,
  signature: op.signature,
}

describe('UserOperations for the DeleGator', () => {
  test('a batch decodes back to its calls; other call data is no batch', () => {
    const calls = [approvePaymaster(BASE, PAYMASTER, 5n), { target: BASE.usdc.address, value: 0n, callData: '0x01' }]
    expect(decodeBatch(executeBatch(calls))).toEqual(calls)
    expect(decodeBatch('0xdeadbeef')).toBeUndefined()
  })

  test('v0.7 packs the verification gas first, and the paymaster with its two gas limits', () => {
    expect(accountGasLimits(op)).toBe(
      `0x${61_585n.toString(16).padStart(32, '0')}${275_767n.toString(16).padStart(32, '0')}`,
    )
    expect(paymasterAndData(op).toLowerCase()).toBe(
      `${PAYMASTER.toLowerCase()}${46_456n.toString(16).padStart(32, '0')}${43_715n.toString(16).padStart(32, '0')}0200`,
    )
    expect(paymasterAndData(bare)).toBe('0x')
  })

  test("a signature over the DeleGator's typed data recovers to the account over its digest", async () => {
    const signature = await account.signTypedData(delegatorTypedData(op, BASE, ENTRY_POINT))
    expect(await recoverAddress({ hash: delegatorDigest(op, BASE, ENTRY_POINT), signature })).toBe(account.address)
    const other = await recoverAddress({ hash: delegatorDigest({ ...op, nonce: 4n }, BASE, ENTRY_POINT), signature })
    expect(other).not.toBe(account.address)
  })

  test('the bundler form carries the 7702 authorization only when given; Privy always gets paymaster fields', () => {
    const auth = { address: BASE.delegation.delegator, chainId: 8453, nonce: 14, r: '0x01', s: '0x02', yParity: 1 }
    expect(toBundlerJson(op)).not.toHaveProperty('eip7702Auth')
    expect(toBundlerJson(op, auth)).toMatchObject({
      nonce: '0x3',
      eip7702Auth: { chainId: '0x2105', nonce: '0xe', yParity: '0x1' },
    })
    expect(toPrivyJson(bare)).toMatchObject({
      paymaster: '0x0000000000000000000000000000000000000000',
      paymaster_data: '0x',
      call_gas_limit: '0x43537',
    })
  })
})

/** The Worker's upgrade draft: the DeleGator's typed data as JSON, bigints as decimal strings. */
const draftOf = (operation: UserOperation, entryPoint = ENTRY_POINT): unknown =>
  JSON.parse(
    JSON.stringify(delegatorTypedData(operation, BASE, entryPoint), (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  )

describe("reviewing the owner's upgrade before they sign it", () => {
  const STRANGER = '0x3333333333333333333333333333333333333333'
  const choice = { chain: BASE, owner: account.address, feeCeiling: UPGRADE_FEE_CEILINGS.base }
  const approving = (spender: string, amount: bigint): UserOperation => ({
    ...op,
    callData: executeBatch([approvePaymaster(BASE, spender, amount)]),
  })

  test("a batch that only approves the paymaster within the ceiling passes, as exactly the DeleGator's typed data", () => {
    const reviewed = reviewOwnerUpgrade(draftOf(op), choice)
    expect(reviewed.maxFee).toBe(16_319n)
    expect(reviewed.typedData).toEqual(draftOf(op))
    // Ethereum's ceiling is higher: the same three dollars of gas pass there and not on Base.
    const dear = draftOf(approving(PAYMASTER, 3_000_000n))
    expect(reviewOwnerUpgrade(dear, { ...choice, feeCeiling: UPGRADE_FEE_CEILINGS.ethereum }).maxFee).toBe(3_000_000n)
    expect(() => reviewOwnerUpgrade(dear, choice)).toThrow(/above the 0.1 USDC ceiling/u)
  })

  test.each([
    ['another chain', draftOf(op), { ...choice, chain: ARBITRUM }],
    ['a chain without UserOperations', draftOf(op), { ...choice, chain: TEMPO }],
    ["someone else's account", draftOf(op), { ...choice, owner: STRANGER }],
    ['another EntryPoint', draftOf(op, STRANGER), choice],
    ['another paymaster taking the gas', draftOf({ ...op, paymaster: STRANGER }), choice],
    ['an approval for someone else', draftOf(approving(STRANGER, 1n)), choice],
    ['gas above the ceiling', draftOf(approving(PAYMASTER, 100_001n)), choice],
    [
      'a second call in the batch',
      draftOf({
        ...op,
        callData: executeBatch([
          approvePaymaster(BASE, PAYMASTER, 1n),
          { target: BASE.usdc.address, value: 0n, callData: '0xa9059cbb' },
        ]),
      }),
      choice,
    ],
    [
      'a USDC call that is not an approval',
      draftOf({ ...op, callData: executeBatch([{ target: BASE.usdc.address, value: 0n, callData: '0xa9059cbb' }]) }),
      choice,
    ],
    ['something that is not typed data', 'sign me', choice],
  ])('refuses %s', (_case, draft, against) => {
    expect(() => reviewOwnerUpgrade(draft, against)).toThrow(/^upgrade_mismatch: /u)
  })
})
