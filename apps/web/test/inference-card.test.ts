import { describe, expect, it } from 'vitest'
import type { PayChoice, UsageToday } from '@goblin/contracts'
import { routesOf, waysOf } from '../src/components/inference-card.tsx'
import { offersPay } from '../src/components/connect-offer.tsx'
import { payingPerCall, walletPaysWhenSpent } from '../src/lib/pay.ts'

const PAY: PayChoice = { mode: 'credits-then-wallet', route: 'goblin', routes: ['goblin', 'tempo'], walletReady: true }
const day = (used: number, limit: number): UsageToday => ({ used, limit, resetsAt: 86_400 })

describe('how goblin pays for its model (ADR 0047)', () => {
  it('offers Credits first then the wallet, Credits only and the wallet only, while the stage sells a route', () => {
    expect(waysOf(PAY).map((way) => [way.mode, way.title])).toEqual([
      ['credits-then-wallet', 'Credits first, then your wallet'],
      ['credits', 'Credits only'],
      ['wallet', 'Your wallet only'],
    ])
    expect(waysOf({ ...PAY, mode: 'credits', routes: [] }).map((way) => way.mode)).toEqual(['credits'])
  })

  it('offers a route only for a way that pays from the wallet, and only when the stage sells more than one', () => {
    expect(routesOf(PAY)).toEqual(['goblin', 'tempo'])
    expect(routesOf({ ...PAY, mode: 'wallet' })).toEqual(['goblin', 'tempo'])
    expect(routesOf({ ...PAY, mode: 'credits' })).toEqual([])
    expect(routesOf({ ...PAY, routes: ['goblin'] })).toEqual([])
  })

  it('says a call is paid per call in wallet mode, and once the Credits are spent while the wallet can pay', () => {
    expect(payingPerCall({ ...PAY, mode: 'wallet', walletReady: false }, day(0, 200))).toBe(true)
    expect(payingPerCall(PAY, day(10, 200))).toBe(false)
    expect(payingPerCall(PAY, day(200, 200))).toBe(true)
    expect(payingPerCall({ ...PAY, walletReady: false }, day(200, 200))).toBe(false)
    expect(payingPerCall({ ...PAY, mode: 'credits' }, day(200, 200))).toBe(false)
    expect(payingPerCall(undefined, day(200, 200))).toBe(false)
    expect(walletPaysWhenSpent({ ...PAY, mode: 'credits' })).toBe(false)
  })

  it('offers to set up the wallet while a way would pay from it and it cannot yet, never on Credits only', () => {
    expect(offersPay({ ...PAY, walletReady: false })).toBe(true)
    expect(offersPay(PAY)).toBe(false)
    expect(offersPay({ ...PAY, mode: 'credits', walletReady: false })).toBe(false)
    expect(offersPay({ ...PAY, mode: 'credits', routes: [], walletReady: false })).toBe(false)
    expect(offersPay(undefined)).toBe(false)
  })
})
