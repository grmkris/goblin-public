import { describe, expect, test } from 'vitest'
import { parseUnits } from '../amounts/index.ts'
import { type FloatDecision, type FloatInput, planRefill } from './float.ts'

const usdc = (value: string): bigint => parseUnits(value, 6)

/** A funded owner with a fresh $20/hour allowance, an empty agent on Base and the policy's $5 route cap. */
const base: FloatInput = {
  held: 0n,
  allowance: usdc('20'),
  owner: usdc('50'),
  agent: 0n,
  feeMargin: usdc('0.1'),
  maxBridge: usdc('5'),
}

const refill = (amount: string): FloatDecision => ({ kind: 'refill', amount: usdc(amount) })
const skip = (reason: 'full' | 'source_short', available: string): FloatDecision => ({
  kind: 'skip',
  reason,
  available: usdc(available),
})

describe('planRefill', () => {
  test.each<[string, Partial<FloatInput>, FloatDecision]>([
    ['an empty float is brought to the $3 target', {}, refill('3')],
    ['a float just under $1 tops up to $3', { held: usdc('0.99') }, refill('2.01')],
    ['a float at exactly $1 is full', { held: usdc('1') }, skip('full', '5')],
    ['a float above $1 is full', { held: usdc('2.5') }, skip('full', '5')],
    ['the top-up is whole cents, rounded up', { held: usdc('0.123456') }, refill('2.88')],
    ['the allowance left this period caps it, less the gas', { allowance: usdc('1.6') }, refill('1.5')],
    ["the owner's Base USDC caps it, less the gas", { owner: usdc('2.25') }, refill('2.15')],
    ["the agent's own Base USDC adds to the source", { allowance: usdc('1'), agent: usdc('1') }, refill('1.9')],
    ['a capped refill under $0.50 is skipped', { allowance: usdc('0.55') }, skip('source_short', '0.45')],
    ['exactly $0.50 after the gas still goes', { allowance: usdc('0.6') }, refill('0.5')],
    ['an exhausted allowance skips', { allowance: 0n }, skip('source_short', '0')],
    ['an owner with nothing on Base skips', { owner: usdc('0.05') }, skip('source_short', '0')],
    ['the gas margin alone is no source', { allowance: usdc('0.1') }, skip('source_short', '0')],
    ['a cap never leaves fractions of a cent', { allowance: usdc('1.234567') }, refill('1.13')],
    ['a payment above the float refills to cover it', { held: usdc('2'), need: usdc('4.5') }, refill('2.5')],
    ['a payment above the target is the goal', { need: usdc('4.2') }, refill('4.2')],
    ['the route cap bounds a large need', { need: usdc('9') }, refill('5')],
    ['a small shortfall still bridges the minimum', { held: usdc('2.9'), need: usdc('3.1') }, refill('0.5')],
    ['a payment the float covers is full', { held: usdc('1.5'), need: usdc('0.02') }, skip('full', '5')],
  ])('%s', (_name, overrides, expected) => {
    expect(planRefill({ ...base, ...overrides })).toEqual(expected)
  })

  test('the thresholds are the inputs, not constants, when given', () => {
    const input = { ...base, held: usdc('4'), low: usdc('5'), target: usdc('8'), minimum: usdc('1') }
    expect(planRefill(input)).toEqual(refill('4'))
    expect(planRefill({ ...input, maxBridge: usdc('0.9') })).toEqual(skip('source_short', '0.9'))
  })
})
