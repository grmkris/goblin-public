import {
  createAllowedCalldataTerms,
  createAllowedMethodsTerms,
  createAllowedTargetsTerms,
  createERC20TokenPeriodTransferTerms,
  createERC20TransferAmountTerms,
  createLimitedCallsTerms,
  createTimestampTerms,
  createValueLteTerms,
  encodeDelegations,
  hashDelegation,
} from '@metamask/delegation-core'
import {
  type Address,
  type Hex,
  concat,
  decodeFunctionData,
  domainSeparator,
  encodePacked,
  keccak256,
  pad,
  toFunctionSelector,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { ARBITRUM, BASE, ETHEREUM, TEMPO } from '../chains/index.ts'
import {
  ALLOWANCE_PERIOD_S,
  type AllowanceChoice,
  allowanceRedeemCalldata,
  assertAllowance,
  buildAllowance,
  choiceSpec,
  confirmAllowance,
  prepareAllowance,
  reviewAllowance,
} from './allowance.ts'
import {
  type Delegation,
  delegationDigest,
  delegationDomain,
  delegationHash,
  delegationManagerAbi,
  disableCalldata,
  transferExecution,
} from './encoding.ts'

/** Throwaway test keys, never funded. */
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const AGENT: Address = '0xD354C247817d233Ee0abDB9ffcDF356b5E6B274F'
const NOW_MS = 1_800_000_000_000
const NOW_S = 1_800_000_000
const SALT = 0x1234n

const choice = (overrides: Partial<AllowanceChoice> = {}): AllowanceChoice => ({
  chain: BASE,
  owner: owner.address,
  agent: AGENT,
  perHour: '20',
  days: 7,
  ...overrides,
})

/** delegation-core's struct for the same delegation (mutable arrays, as it types them). */
const struct = (x: Delegation) => ({ ...x, caveats: x.caveats.map((item) => ({ ...item })) })
const lower = (items: { enforcer: Address; terms: Hex; args: Hex }[]) =>
  items.map((item) => ({ ...item, terms: item.terms.toLowerCase() }))

describe('the owner allowance as an ERC-7710 delegation', () => {
  test('caveats are, term for term, what MetaMask delegation-core encodes', () => {
    const spec = choiceSpec(choice(), NOW_S, SALT)
    const x = buildAllowance(spec)
    const e = BASE.delegation.enforcers
    expect(x).toMatchObject({ delegate: AGENT, delegator: owner.address, salt: SALT, signature: '0x' })
    expect(x.caveats).toEqual(
      lower([
        { enforcer: e.allowedTargets, terms: createAllowedTargetsTerms({ targets: [BASE.usdc.address] }), args: '0x' },
        {
          enforcer: e.allowedMethods,
          terms: createAllowedMethodsTerms({ selectors: [toFunctionSelector('function transfer(address,uint256)')] }),
          args: '0x',
        },
        { enforcer: e.valueLte, terms: createValueLteTerms({ maxValue: 0n }), args: '0x' },
        {
          enforcer: e.timestamp,
          terms: createTimestampTerms({ afterThreshold: 0, beforeThreshold: NOW_S + 7 * 86_400 }),
          args: '0x',
        },
        {
          enforcer: e.allowedCalldata,
          terms: createAllowedCalldataTerms({ startIndex: 4, value: pad(AGENT, { size: 32 }) }),
          args: '0x',
        },
        {
          enforcer: e.erc20PeriodTransfer,
          terms: createERC20TokenPeriodTransferTerms({
            tokenAddress: BASE.usdc.address,
            periodAmount: 20_000_000n,
            periodDuration: ALLOWANCE_PERIOD_S,
            startDate: NOW_S - 60,
          }),
          args: '0x',
        },
      ]),
    )
  })

  test('a one-off allowance: one call, exactly the amount, exactly to the agent', () => {
    const x = buildAllowance({
      kind: 'allowance-once',
      chain: ARBITRUM,
      owner: owner.address,
      agent: AGENT,
      amount: 3_000_000n,
      start: NOW_S,
      salt: SALT,
    })
    const e = ARBITRUM.delegation.enforcers
    const transfer = transferExecution(ARBITRUM.usdc.address, AGENT, 3_000_000n).callData
    expect(x.caveats.slice(3)).toEqual(
      lower([
        {
          enforcer: e.timestamp,
          terms: createTimestampTerms({ afterThreshold: 0, beforeThreshold: NOW_S + 600 }),
          args: '0x',
        },
        { enforcer: e.limitedCalls, terms: createLimitedCallsTerms({ limit: 1 }), args: '0x' },
        {
          enforcer: e.allowedCalldata,
          terms: createAllowedCalldataTerms({ startIndex: 4, value: pad(AGENT, { size: 32 }) }),
          args: '0x',
        },
        {
          enforcer: e.allowedCalldata,
          terms: createAllowedCalldataTerms({ startIndex: 0, value: transfer }),
          args: '0x',
        },
        {
          enforcer: e.erc20TransferAmount,
          terms: createERC20TransferAmountTerms({ tokenAddress: ARBITRUM.usdc.address, maxAmount: 3_000_000n }),
          args: '0x',
        },
      ]),
    )
  })

  test('the hash is the framework’s, and the digest is EIP-712 under each chain’s DelegationManager', () => {
    for (const chain of [BASE, ETHEREUM, ARBITRUM, TEMPO]) {
      const x = buildAllowance(choiceSpec(choice({ chain }), NOW_S, SALT))
      expect(delegationHash(x)).toBe(hashDelegation(struct(x)))
      const separator = domainSeparator({ domain: delegationDomain(chain) })
      expect(delegationDigest(chain, x)).toBe(keccak256(concat(['0x1901', separator, delegationHash(x)])))
    }
    // The same choice on another chain is another delegation: the domain differs, the hash of the struct may not.
    const base = buildAllowance(choiceSpec(choice(), NOW_S, SALT))
    const ethereum = buildAllowance(choiceSpec(choice({ chain: ETHEREUM }), NOW_S, SALT))
    expect(delegationDigest(BASE, base)).not.toBe(delegationDigest(ETHEREUM, ethereum))
  })

  test('prepare → owner signs the typed data → confirm accepts the owner and refuses anyone else', async () => {
    const prepared = prepareAllowance(choice(), NOW_MS, SALT)
    expect(prepared).toMatchObject({ chainId: 8453, perHour: '20', expiresAt: '2027-01-22T08:00:00.000Z' })
    const typed = prepared.typedData
    const message = {
      ...prepared.delegation,
      caveats: prepared.delegation.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
      salt: BigInt(prepared.delegation.salt),
    }
    const signature = await owner.signTypedData({
      domain: delegationDomain(BASE),
      types: { Caveat: [...(typed.types['Caveat'] ?? [])], Delegation: [...(typed.types['Delegation'] ?? [])] },
      primaryType: 'Delegation',
      message,
    })
    const signed = await confirmAllowance(BASE, prepared, owner.address, signature)
    expect(signed).toMatchObject({ delegationHash: prepared.delegationHash, perHour: '20' })
    expect(signed.delegation.signature).toBe(signature)
    const forged = await stranger.signTypedData({
      domain: delegationDomain(BASE),
      types: { Caveat: [...(typed.types['Caveat'] ?? [])], Delegation: [...(typed.types['Delegation'] ?? [])] },
      primaryType: 'Delegation',
      message,
    })
    await expect(confirmAllowance(BASE, prepared, owner.address, forged)).rejects.toThrow('invalid_signature')
    await expect(confirmAllowance(ETHEREUM, prepared, owner.address, signature)).rejects.toThrow('allowance_mismatch')
    const tampered = { ...prepared, delegation: { ...prepared.delegation, delegate: stranger.address } }
    await expect(confirmAllowance(BASE, tampered, owner.address, signature)).rejects.toThrow('allowance_mismatch')

    // The agent redeems a top-up: the signed delegation as context, one single-mode transfer to itself.
    const data = allowanceRedeemCalldata(BASE, signed.delegation, 1_500_000n)
    const decoded = decodeFunctionData({ abi: delegationManagerAbi, data })
    expect(decoded.functionName).toBe('redeemDelegations')
    const delegation = { ...buildAllowance(choiceSpec(choice(), NOW_S, SALT)), signature }
    expect(decoded.args[0]).toEqual([encodeDelegations([struct(delegation)])])
    expect(decoded.args[1]).toEqual([pad('0x00', { size: 32 })])
    expect(decoded.args[2]).toEqual([
      encodePacked(
        ['address', 'uint256', 'bytes'],
        [BASE.usdc.address, 0n, transferExecution(BASE.usdc.address, AGENT, 1_500_000n).callData],
      ),
    ])
    expect(() => allowanceRedeemCalldata(BASE, prepared.delegation, 1n)).toThrow('not signed')
  })

  test('review: the browser rebuilds what the owner chose and refuses any difference', () => {
    const prepared = prepareAllowance(choice(), NOW_MS, SALT)
    const reviewed = reviewAllowance(prepared, choice(), NOW_MS + 30_000)
    expect(reviewed.delegationHash).toBe(prepared.delegationHash)
    expect(reviewed.description).toMatchObject({ perHour: '20', periodSeconds: 3600, token: 'USDC', agent: AGENT })
    const refusals: readonly (readonly [string, AllowanceChoice, number | undefined])[] = [
      ['more per hour than chosen', choice({ perHour: '21' }), undefined],
      ['another agent', choice({ agent: stranger.address }), undefined],
      ['longer than chosen', choice({ days: 8 }), undefined],
      ['another chain', choice({ chain: ARBITRUM }), undefined],
      ['another owner', choice({ owner: stranger.address }), undefined],
      ['stale', choice(), NOW_MS + 600_000],
    ]
    for (const [name, expected, at] of refusals)
      expect(() => reviewAllowance(prepared, expected, at ?? NOW_MS), name).toThrow('allowance_mismatch')
    const extra = {
      ...prepared,
      typedData: {
        ...prepared.typedData,
        message: {
          ...prepared.typedData.message,
          caveats: [
            ...prepared.delegation.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
            { enforcer: AGENT, terms: '0x' },
          ],
        },
      },
    }
    // The server's message is never what gets signed; a draft whose hash is not the rebuild's is refused.
    expect(reviewAllowance(extra, choice(), NOW_MS).typedData.message['caveats']).toHaveLength(6)
    expect(() => reviewAllowance({ ...prepared, delegationHash: `0x${'00'.repeat(32)}` }, choice(), NOW_MS)).toThrow(
      'allowance_mismatch',
    )
  })

  test('assertAllowance refuses args, extra caveats and another authority; disable encodes the same delegation', () => {
    const spec = choiceSpec(choice(), NOW_S, SALT)
    const x = buildAllowance(spec)
    expect(() => assertAllowance(spec, x)).not.toThrow()
    const withArgs: Delegation = {
      ...x,
      caveats: x.caveats.map((item, index) => (index === 0 ? { ...item, args: '0x01' as const } : item)),
    }
    const extra = { ...x, caveats: [...x.caveats, x.caveats[0] ?? x.caveats[1]].filter((item) => item !== undefined) }
    const parent: Delegation = { ...x, authority: `0x${'ab'.repeat(32)}` }
    for (const grant of [withArgs, extra, parent])
      expect(() => assertAllowance(spec, grant)).toThrow('allowance_mismatch')
    const { functionName, args } = decodeFunctionData({ abi: delegationManagerAbi, data: disableCalldata(x) })
    expect(functionName).toBe('disableDelegation')
    expect(args[0]).toMatchObject({ delegate: AGENT, delegator: owner.address, salt: SALT })
  })

  test('choices outside the bounds are refused', () => {
    expect(() => prepareAllowance(choice({ days: 0 }), NOW_MS)).toThrow('invalid_allowance')
    expect(() => prepareAllowance(choice({ days: 31 }), NOW_MS)).toThrow('invalid_allowance')
    expect(() => prepareAllowance(choice({ perHour: '0' }), NOW_MS)).toThrow('invalid_allowance')
    expect(() => prepareAllowance(choice({ perHour: '1e3' }), NOW_MS)).toThrow('invalid_amount')
  })
})
