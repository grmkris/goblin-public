import type { Operation } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { amountMeaning, deliveryStep, modelSummary, paymentStep } from './receipt-model.ts'

const operation = (patch: Partial<Operation>): Operation => ({
  id: 'op_test_0001',
  status: 'delivered',
  terms: {
    kind: 'paid_fetch',
    chain: 'base',
    rail: 'x402',
    subject: 'Exa search',
    token: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    amount: '0.007',
    amountUsd: '0.007',
    recipient: '0xE8a1b2C3d4E5f60718293a4B5c6D7e8F90a1B2c3',
    expiresAt: '2026-10-12T06:00:00Z',
  },
  termsHash: '0xab',
  limitsVersion: 1,
  createdAt: '2026-10-12T05:00:00Z',
  updatedAt: '2026-10-12T05:00:00Z',
  ...patch,
})

describe('receipt model', () => {
  it('keeps payment and delivery apart', () => {
    const paidNotDelivered = operation({ status: 'confirmed', delivery: { status: '502', detail: 'bad gateway' } })
    expect(paymentStep(paidNotDelivered).tone).toBe('ok')
    expect(deliveryStep(paidNotDelivered)).toMatchObject({ label: 'Failed, HTTP 502', tone: 'bad' })
    expect(deliveryStep(operation({ delivery: { status: '200' } }))?.label).toBe('Delivered, HTTP 200')
    expect(deliveryStep(operation({ status: 'confirmed' }))?.label).toBe('Waiting for the service')
    expect(deliveryStep(operation({ status: 'awaiting_approval' }))).toBeUndefined()
  })

  it('never calls an uncertain payment paid or failed', () => {
    const step = paymentStep(operation({ status: 'uncertain' }))
    expect(step.label).toBe('Not confirmed')
    expect(step.detail).toBe('Held, and never paid again on its own. Check its status to settle or release it.')
    expect(deliveryStep(operation({ status: 'uncertain' }))?.label).toBe('Unknown')
  })

  it('says whether the amount was asked for, held, paid or not charged', () => {
    expect(amountMeaning(operation({ status: 'awaiting_approval' }))).toBe('Requested')
    expect(amountMeaning(operation({ status: 'submitted' }))).toBe('Held')
    expect(amountMeaning(operation({ status: 'uncertain' }))).toBe('Held, not confirmed')
    expect(amountMeaning(operation({ status: 'delivered' }))).toBe('Paid')
    expect(amountMeaning(operation({ status: 'failed' }))).toBe('Not charged')
  })

  it('summarises in one bounded line', () => {
    const line = modelSummary(operation({ delivery: { status: '200' } }))
    expect(line).toContain('$0.007')
    expect(line).toContain('op_test_0001')
    expect(line.length).toBeLessThanOrEqual(500)
  })
})
