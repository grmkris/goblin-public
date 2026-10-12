import {
  createAllowedCalldataTerms,
  createERC20TokenPeriodTransferTerms,
  createTimestampTerms,
  hashDelegation,
} from '@metamask/delegation-core'
import { type Address, getAddress, pad } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { BASE } from '../chains/index.ts'
import { SUBSCRIPTION_MAX_PERIODS } from '../contract/merchant.ts'
import { type Delegation, delegationDomain, fromDelegationJson } from './encoding.ts'
import {
  type SubscriptionChoice,
  type SubscriptionTerms,
  confirmSubscription,
  periodAt,
  periodCount,
  periodStart,
  prepareSubscription,
  reviewSubscription,
} from './subscription.ts'

/** Throwaway test key, never funded. */
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const COLLECTOR: Address = getAddress('0x8f3a1b2c4d5e6f708192a3b4c5d6e7f8091ac41d')
const SALT = 0x5ab0n
const DAY_MS = 86_400_000
/** 2027-01-15T08:00:00Z, and the midnight UTC that began that day. */
const NOW_MS = 1_800_000_000_000
const MIDNIGHT_MS = Date.parse('2027-01-15T00:00:00.000Z')

const DAY: SubscriptionTerms = { billing: 'day', amountUsd: '1.00', periodDays: 1, months: 12 }
const MONTH: SubscriptionTerms = { billing: 'month', amountUsd: '15.00', periodDays: 30, months: 12 }

const choice = (terms: SubscriptionTerms): SubscriptionChoice => ({
  chain: BASE,
  owner: owner.address,
  collector: COLLECTOR,
  terms,
})

/** delegation-core's struct for the same delegation (mutable arrays, as it types them). */
const struct = (x: Delegation) => ({ ...x, caveats: x.caveats.map((item) => ({ ...item })) })
const termsOf = (x: Delegation, enforcer: Address) =>
  x.caveats.find((item) => item.enforcer.toLowerCase() === enforcer.toLowerCase())?.terms

describe('a subscription as an ERC-7710 delegation', () => {
  test('a day pass: $1 a period of one UTC day, from the midnight that began the day it was prepared, for a year', () => {
    const prepared = prepareSubscription(choice(DAY), NOW_MS, SALT)
    expect(prepared).toMatchObject({ startsAt: '2027-01-15T00:00:00.000Z', expiresAt: '2028-01-15T00:00:00.000Z' })
    const x = fromDelegationJson(prepared.delegation)
    const e = BASE.delegation.enforcers
    const start = MIDNIGHT_MS / 1000
    expect(termsOf(x, e.erc20PeriodTransfer)).toBe(
      createERC20TokenPeriodTransferTerms({
        tokenAddress: BASE.usdc.address,
        periodAmount: 1_000_000n,
        periodDuration: 86_400,
        startDate: start,
      }).toLowerCase(),
    )
    expect(termsOf(x, e.timestamp)).toBe(
      createTimestampTerms({ afterThreshold: 0, beforeThreshold: start + 365 * 86_400 }).toLowerCase(),
    )
    expect(termsOf(x, e.allowedCalldata)).toBe(
      createAllowedCalldataTerms({ startIndex: 4, value: pad(COLLECTOR, { size: 32 }) }).toLowerCase(),
    )
    expect(x.delegate).toBe(COLLECTOR)
    expect(prepared.delegationHash).toBe(hashDelegation(struct(x)))
    // Prepared any time that day, it is the same delegation; the next day it starts a day later.
    expect(prepareSubscription(choice(DAY), MIDNIGHT_MS + DAY_MS - 1, SALT).delegationHash).toBe(
      prepared.delegationHash,
    )
    expect(prepareSubscription(choice(DAY), MIDNIGHT_MS + DAY_MS, SALT).startsAt).toBe('2027-01-16T00:00:00.000Z')
  })

  test('a month: $15 a period of 30 days from a minute before it was prepared, for twelve of them', () => {
    const prepared = prepareSubscription(choice(MONTH), NOW_MS, SALT)
    const start = NOW_MS / 1000 - 60
    expect(prepared.startsAt).toBe(new Date(start * 1000).toISOString())
    expect(prepared.expiresAt).toBe(new Date((start + 360 * 86_400) * 1000).toISOString())
    const x = fromDelegationJson(prepared.delegation)
    expect(termsOf(x, BASE.delegation.enforcers.erc20PeriodTransfer)).toBe(
      createERC20TokenPeriodTransferTerms({
        tokenAddress: BASE.usdc.address,
        periodAmount: 15_000_000n,
        periodDuration: 30 * 86_400,
        startDate: start,
      }).toLowerCase(),
    )
    expect(prepared.delegationHash).toBe(hashDelegation(struct(x)))
  })

  test('periods are whole ones within the months; a day pass counts UTC days from 1', () => {
    expect(periodCount(DAY)).toBe(365)
    expect(periodCount(MONTH)).toBe(12)
    expect(periodCount({ periodDays: 1, months: 24 })).toBe(SUBSCRIPTION_MAX_PERIODS)
    const startsAt = '2027-01-15T00:00:00.000Z'
    expect(periodAt(startsAt, DAY, MIDNIGHT_MS - 1)).toBe(0)
    expect(periodAt(startsAt, DAY, NOW_MS)).toBe(1)
    expect(periodAt(startsAt, DAY, MIDNIGHT_MS + DAY_MS - 1)).toBe(1)
    expect(periodAt(startsAt, DAY, MIDNIGHT_MS + DAY_MS)).toBe(2)
    expect(periodAt(startsAt, DAY, MIDNIGHT_MS + 364 * DAY_MS + 1)).toBe(365)
    expect(periodStart(startsAt, DAY, 2)).toBe('2027-01-16T00:00:00.000Z')
  })

  test('terms outside the bounds are refused', () => {
    for (const terms of [
      { ...DAY, periodDays: 30 },
      { ...MONTH, periodDays: 31 },
      { ...MONTH, periodDays: 0 },
      { ...MONTH, months: 25 },
      { ...DAY, months: 0 },
    ])
      expect(() => prepareSubscription(choice(terms), NOW_MS, SALT), JSON.stringify(terms)).toThrow(
        'invalid_subscription',
      )
  })

  test('review: a day pass prepared before midnight still checks after it; anything else differs', () => {
    const late = MIDNIGHT_MS + DAY_MS - 60_000
    const prepared = prepareSubscription(choice(DAY), late, SALT)
    const reviewed = reviewSubscription(prepared, choice(DAY), late + 120_000)
    expect(reviewed.delegationHash).toBe(prepared.delegationHash)
    expect(reviewed.description).toMatchObject({
      billing: 'day',
      amountUsd: '1.00',
      periodDays: 1,
      months: 12,
      startsAt: '2027-01-15T00:00:00.000Z',
      secondPaymentAt: '2027-01-16T00:00:00.000Z',
      expiresAt: '2028-01-15T00:00:00.000Z',
      collector: COLLECTOR,
    })
    const refusals: readonly (readonly [string, SubscriptionTerms, number])[] = [
      ['billed by the month', { ...DAY, billing: 'month' }, late],
      ['more a day', { ...DAY, amountUsd: '1.01' }, late],
      ['for longer', { ...DAY, months: 13 }, late],
      ['the next day, once the window passed', DAY, late + 600_000],
      ['from the day before', DAY, late - DAY_MS],
    ]
    for (const [name, terms, at] of refusals)
      expect(() => reviewSubscription(prepared, choice(terms), at), name).toThrow('subscription_mismatch')
  })

  test('review: a month is checked within five minutes of being prepared', () => {
    const prepared = prepareSubscription(choice(MONTH), NOW_MS, SALT)
    expect(reviewSubscription(prepared, choice(MONTH), NOW_MS + 60_000).description).toMatchObject({
      billing: 'month',
      secondPaymentAt: new Date(NOW_MS - 60_000 + 30 * DAY_MS).toISOString(),
    })
    expect(() => reviewSubscription(prepared, choice(MONTH), NOW_MS + 600_000)).toThrow('subscription_mismatch')
    expect(() => reviewSubscription(prepared, choice({ ...MONTH, periodDays: 29 }), NOW_MS)).toThrow(
      'subscription_mismatch',
    )
  })

  test('confirm attaches the owner’s signature over the rebuilt day pass and keeps its UTC-day window', async () => {
    const prepared = prepareSubscription(choice(DAY), NOW_MS, SALT)
    const reviewed = reviewSubscription(prepared, choice(DAY), NOW_MS)
    const typed = reviewed.typedData
    const signature = await owner.signTypedData({
      domain: delegationDomain(BASE),
      types: { Caveat: [...(typed.types['Caveat'] ?? [])], Delegation: [...(typed.types['Delegation'] ?? [])] },
      primaryType: 'Delegation',
      message: {
        ...prepared.delegation,
        caveats: prepared.delegation.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
        salt: BigInt(prepared.delegation.salt),
      },
    })
    const signed = await confirmSubscription(BASE, prepared, owner.address, signature)
    expect(signed).toMatchObject({
      delegationHash: prepared.delegationHash,
      startsAt: '2027-01-15T00:00:00.000Z',
      expiresAt: '2028-01-15T00:00:00.000Z',
    })
    expect(signed.delegation.signature).toBe(signature)
  })
})
