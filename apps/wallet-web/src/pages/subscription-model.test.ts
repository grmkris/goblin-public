import type { SubscriptionView } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import {
  DAY_PASS_REQUEST_ID,
  SUBSCRIPTION_REQUEST_ID,
  fixtureSubscriptions,
  signedNow,
} from '../api/subscription-fixtures.ts'
import {
  billingLine,
  cancelText,
  firstPaymentNote,
  offerLine,
  shownSubscriptions,
  standingOf,
  termsOf,
} from './subscription-model.ts'

/** 2027-01-15T08:00:00Z, and the UTC midnight that ends that day. */
const NOW = Date.parse('2027-01-15T08:00:00.000Z')
const TONIGHT = '2027-01-16T00:00:00.000Z'
const HOUR = 3_600_000

const date = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const fullDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
/** The UTC day's end on a clock in `timeZone`, as the model says a time: "02:00" in Berlin in winter is 01:00. */
const clockIn = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone })

const views = fixtureSubscriptions(true, NOW)
const find = (predicate: (view: SubscriptionView) => boolean): SubscriptionView =>
  views.find(predicate) ?? expect.fail('the fixtures hold it')
const monthRequest = find((view) => view.id === SUBSCRIPTION_REQUEST_ID)
const dayRequest = find((view) => view.id === DAY_PASS_REQUEST_ID)
const dayPass = find((view) => view.billing === 'day' && view.status === 'active')
const monthly = find((view) => view.billing === 'month' && view.status === 'active')

describe('a subscription in words, per billing', () => {
  it('names the offer as the signing screen titles it', () => {
    expect(offerLine(dayRequest)).toBe('goblin Pro · $1.00 a day you use goblin')
    expect(offerLine(monthRequest)).toBe('goblin Pro · $15.00 every 30 days')
    expect(billingLine(dayPass)).toBe('$1.00 a day you use goblin')
    expect(billingLine(monthly)).toBe('$15.00 every 30 days')
  })

  it('signs a day pass for a UTC day at a time over twelve months, and a month for twelve payments', () => {
    const [, , dayAmount, dayUntil] = termsOf(dayRequest, NOW)
    expect(dayAmount).toEqual({
      id: 'amount',
      title: 'At most $1 a day',
      detail: 'goblin takes it only on days you use it. A day runs midnight to midnight UTC.',
    })
    expect(dayUntil).toEqual({
      id: 'until',
      title: 'For 12 months',
      detail: `Until ${fullDate('2028-01-15T00:00:00.000Z')}, or until you cancel.`,
    })
    const [, , monthAmount, monthUntil] = termsOf(monthRequest, NOW)
    expect(monthAmount).toMatchObject({
      title: 'At most $15 every 30 days',
      detail: `The first payment right after you sign, the next from ${date(new Date(NOW - 60_000 + 30 * 24 * HOUR).toISOString())}.`,
    })
    expect(monthUntil).toMatchObject({ title: 'For 12 payments' })
  })

  it('says a day pass is paid until tonight, or when it was last used, and a month through its period', () => {
    expect(dayPass.paidThrough).toBe(TONIGHT)
    expect(standingOf(dayPass, Date.parse(TONIGHT) + 2 * HOUR)).toBe(`Last paid ${date(dayPass.lastPaidAt ?? '')}`)
    expect(standingOf(signedNow(dayRequest, NOW), NOW)).toBe('Nothing taken yet')
    expect(standingOf(monthly, NOW)).toBe(`Paid through ${date(monthly.paidThrough ?? '')}`)
    expect(standingOf(monthly, Date.parse(monthly.paidThrough ?? '') + HOUR)).toBe('Payment due')
    expect(shownSubscriptions(views, NOW).map((view) => view.billing)).toEqual(['month', 'day'])
  })

  it("says where a paid UTC day ends on the owner's clock: the end of today on UTC, else a local time and day", () => {
    // On UTC time the paid day is the owner's own today.
    expect(standingOf(dayPass, NOW, 'UTC')).toBe('Paid for today')
    expect(standingOf({ ...dayPass, status: 'revoked' }, NOW, 'UTC')).toBe(
      'Cancelled. goblin Pro runs to the end of today.',
    )
    expect(cancelText(dayPass, NOW, 'UTC')).toMatch(/^goblin Pro runs to the end of today, the day you paid for\. /u)
    // East of UTC it ends after the owner's own midnight: tomorrow, at their time.
    const berlin = clockIn(TONIGHT, 'Europe/Berlin')
    expect(berlin).toMatch(/^0?1:00/u)
    expect(standingOf(dayPass, NOW, 'Europe/Berlin')).toBe(`Paid until ${berlin} tomorrow`)
    expect(cancelText(dayPass, NOW, 'Europe/Berlin')).toBe(
      `goblin Pro runs until ${berlin} tomorrow, when the day you paid for ends at midnight UTC. You sign one ` +
        'operation from your account; its gas, a few cents, is paid in USDC.',
    )
    // West of UTC it ends this evening.
    const newYork = clockIn(TONIGHT, 'America/New_York')
    expect(standingOf(dayPass, NOW, 'America/New_York')).toBe(`Paid until ${newYork} today`)
    expect(standingOf({ ...dayPass, status: 'revoked' }, NOW, 'America/New_York')).toBe(
      `Cancelled. goblin Pro runs until ${newYork} today.`,
    )
  })

  it('says what cancelling leaves, and what the first payment needs, per billing', () => {
    expect(cancelText(signedNow(dayRequest, NOW), NOW)).toMatch(/^Nothing more is taken\. /u)
    expect(firstPaymentNote(dayRequest, '$0.60')).toEqual({
      title: 'Add $0.60 for your first day',
      text: 'goblin takes $1 the first time you use it each day, from your USDC on Base. You can sign now and add it after.',
    })
    expect(firstPaymentNote(monthRequest, '$5.00').title).toBe('Add $5.00 for the first payment')
  })

  it('signs a monthly subscription with its first payment, and a day pass with none until goblin is used', () => {
    expect(signedNow(monthRequest, NOW)).toMatchObject({ status: 'active', lastPaidAt: new Date(NOW).toISOString() })
    expect(signedNow(dayRequest, NOW)).toMatchObject({
      status: 'active',
      startsAt: '2027-01-15T00:00:00.000Z',
      expiresAt: '2028-01-15T00:00:00.000Z',
    })
    expect(signedNow(dayRequest, NOW).paidThrough).toBeUndefined()
  })
})
