import { describe, expect, test } from 'vitest'
import { open, STRANGER, T0, termsFor, testStore } from './fixtures.ts'

const HOUR = 3_600_000

describe('limits', () => {
  test('start at the defaults and expire after seven days', () => {
    const { store } = testStore()
    expect(store.limits()).toMatchObject({ perCall: '5', perHour: '20', perWeek: '50', version: 1 })
    expect(store.limits().expiresAt).toBe(new Date(T0 + 7 * 24 * HOUR).toISOString())
  })

  test('a new version replaces the old; inconsistent limits are refused', () => {
    const { store } = testStore()
    const next = store.setLimits({ perCall: '1', perHour: '2', perWeek: '3', expiresAt: '2026-11-01T00:00:00.000Z' })
    expect(next).toMatchObject({ perCall: '1', version: 2 })
    expect(store.setLimits({ perCall: '9', perHour: '2', perWeek: '3', expiresAt: '2026-11-01T00:00:00.000Z' })).toBe(
      undefined,
    )
  })
})

describe('begin', () => {
  test('the same id and args replays; different args conflict', () => {
    const { store } = testStore()
    const first = store.begin({
      id: 'op-replay-1',
      argsHash: 'a',
      terms: termsFor('1'),
      termsHash: '0xab',
      client: 'c',
    })
    expect(first.kind).toBe('created')
    expect(
      store.begin({ id: 'op-replay-1', argsHash: 'a', terms: termsFor('1'), termsHash: '0xab', client: 'c' }).kind,
    ).toBe('replay')
    expect(
      store.begin({ id: 'op-replay-1', argsHash: 'b', terms: termsFor('2'), termsHash: '0xcd', client: 'c' }).kind,
    ).toBe('conflict')
    expect(store.activity()).toHaveLength(1)
  })
})

describe('reserve', () => {
  test('a small spend reserves and moves through the journal to delivered', () => {
    const { store } = testStore()
    const op = open(store, '0.01')
    expect(store.reserve(op.id).kind).toBe('reserved')
    expect(store.signing(op.id).ok).toBe(true)
    expect(store.submitted(op.id, { rail: 'x402' }).ok).toBe(true)
    const done = store.settle(op.id, { payment: { rail: 'x402', reference: 'r' }, delivered: true })
    expect(done).toMatchObject({ ok: true, operation: { status: 'delivered', payment: { reference: 'r' } } })
    expect(store.signing(op.id)).toMatchObject({ ok: false, code: 'bad_transition' })
  })

  test('reserving twice is idempotent and counts once', () => {
    const { store } = testStore()
    const op = open(store, '4')
    store.reserve(op.id)
    expect(store.reserve(op.id).kind).toBe('reserved')
    const hour = store.limitViews().find((v) => v.period === 'hour')
    expect(hour?.used).toBe('4')
  })

  test('over the per-call limit waits for approval and reserves nothing', () => {
    const { store } = testStore()
    const op = open(store, '6')
    const outcome = store.reserve(op.id)
    expect(outcome).toMatchObject({ kind: 'awaiting_approval', approval: { reason: 'over_limit', status: 'pending' } })
    expect(outcome.kind === 'awaiting_approval' && outcome.approval.crosses[0]?.period).toBe('call')
    expect(store.limitViews().find((v) => v.period === 'hour')?.used).toBe('0')
  })

  test('the rolling hour: the limit frees up exactly when the oldest reservation leaves the window', () => {
    const { store, clock } = testStore()
    for (const amount of ['5', '5', '5', '5']) store.reserve(open(store, amount).id)
    const blocked = open(store, '1')
    expect(store.reserve(blocked.id).kind).toBe('awaiting_approval')
    clock.now = T0 + HOUR - 1
    expect(store.reserve(open(store, '1').id).kind).toBe('awaiting_approval')
    clock.now = T0 + HOUR
    expect(store.reserve(open(store, '1').id).kind).toBe('reserved')
  })

  test('the week sums across hours', () => {
    const { store, clock } = testStore()
    for (let day = 0; day < 5; day += 1) {
      clock.now = T0 + day * 24 * HOUR
      store.reserve(open(store, '5').id)
      store.reserve(open(store, '5').id)
    }
    clock.now = T0 + 5 * 24 * HOUR
    expect(store.reserve(open(store, '1').id).kind).toBe('awaiting_approval')
  })

  test('two spends racing for the last of the hour: only one fits', () => {
    const { store } = testStore()
    for (const amount of ['5', '5', '5']) store.reserve(open(store, amount).id)
    const a = open(store, '5')
    const b = open(store, '5')
    const outcomes = [store.reserve(a.id).kind, store.reserve(b.id).kind]
    expect(outcomes.filter((kind) => kind === 'reserved')).toHaveLength(1)
    expect(outcomes.filter((kind) => kind === 'awaiting_approval')).toHaveLength(1)
  })

  test('a failed spend releases its reservation; an uncertain one keeps it', () => {
    const { store } = testStore()
    const failed = open(store, '5')
    const unsure = open(store, '5')
    store.reserve(failed.id)
    store.reserve(unsure.id)
    store.signing(unsure.id)
    store.fail(failed.id, 'rail refused')
    expect(store.uncertain(unsure.id, 'timeout')).toMatchObject({ ok: true, operation: { status: 'uncertain' } })
    expect(store.limitViews().find((v) => v.period === 'hour')?.used).toBe('5')
    expect(store.fail(unsure.id, 'x')).toMatchObject({ ok: true })
    expect(store.limitViews().find((v) => v.period === 'hour')?.used).toBe('0')
  })

  test('a quote that expired is refused', () => {
    const { store, clock } = testStore()
    const op = open(store, '1', { expiresAt: new Date(T0 + HOUR).toISOString() })
    clock.now = T0 + 2 * HOUR
    expect(store.reserve(op.id)).toMatchObject({ kind: 'refused', code: 'terms_expired' })
    expect(store.operation(op.id)?.status).toBe('expired')
  })

  test('after the grant expires nothing reserves', () => {
    const { store, clock } = testStore()
    const op = open(store, '1', { expiresAt: new Date(T0 + 30 * 24 * HOUR).toISOString() })
    clock.now = T0 + 8 * 24 * HOUR
    expect(store.reserve(op.id)).toMatchObject({ kind: 'refused', code: 'grant_expired' })
  })
})

describe('approvals', () => {
  test('a first payment to a stranger waits; approval with the right hash lets the retry reserve', () => {
    const { store } = testStore()
    const op = open(store, '1', { kind: 'transfer', rail: 'transfer', recipient: STRANGER })
    const first = store.reserve(op.id)
    expect(first).toMatchObject({ kind: 'awaiting_approval', approval: { reason: 'new_recipient' } })
    expect(store.reserve(op.id).kind).toBe('awaiting_approval')
    expect(store.decide(op.id, { decision: 'approve', termsHash: '0xdeadbeef' })).toMatchObject({
      ok: false,
      code: 'terms_changed',
    })
    expect(store.decide(op.id, { decision: 'approve', termsHash: op.termsHash, remember: true })).toMatchObject({
      ok: true,
      approval: { status: 'approved' },
    })
    expect(store.reserve(op.id).kind).toBe('reserved')
    expect(store.isKnownRecipient('base', STRANGER)).toBe(true)
    const second = open(store, '1', { kind: 'transfer', rail: 'transfer', recipient: STRANGER })
    expect(store.reserve(second.id).kind).toBe('reserved')
  })

  test('an approved over-limit spend reserves and counts', () => {
    const { store } = testStore()
    const op = open(store, '8')
    store.reserve(op.id)
    store.decide(op.id, { decision: 'approve', termsHash: op.termsHash })
    expect(store.reserve(op.id).kind).toBe('reserved')
    expect(store.limitViews().find((v) => v.period === 'hour')?.used).toBe('8')
  })

  test('a decline closes the operation and a later reserve is refused', () => {
    const { store } = testStore()
    const op = open(store, '8')
    store.reserve(op.id)
    store.decide(op.id, { decision: 'decline', termsHash: op.termsHash })
    expect(store.operation(op.id)?.status).toBe('declined')
    expect(store.reserve(op.id)).toMatchObject({ kind: 'refused', code: 'closed' })
  })

  test('an approval nobody answers expires with its operation', () => {
    const { store, clock } = testStore()
    const op = open(store, '8')
    store.reserve(op.id)
    clock.now = T0 + 31 * 60_000
    expect(store.approval(op.id)?.status).toBe('expired')
    expect(store.reserve(op.id)).toMatchObject({ kind: 'refused', code: 'approval_expired' })
    expect(store.decide(op.id, { decision: 'approve', termsHash: op.termsHash })).toMatchObject({
      ok: false,
      code: 'not_pending',
    })
  })
})

describe('signing', () => {
  test('an owner-approved over-limit spend still signs; revoked or expired authority does not', () => {
    const { store, clock } = testStore()
    const big = open(store, '8')
    store.reserve(big.id)
    store.decide(big.id, { decision: 'approve', termsHash: big.termsHash })
    expect(store.reserve(big.id).kind).toBe('reserved')
    expect(store.signing(big.id).ok).toBe(true)
    const late = open(store, '1', { expiresAt: new Date(T0 + 30 * 24 * HOUR).toISOString() })
    store.reserve(late.id)
    clock.now = T0 + 8 * 24 * HOUR
    expect(store.signing(late.id)).toMatchObject({ ok: false, code: 'grant_expired' })
    expect(store.operation(late.id)?.status).toBe('failed')
  })
})

describe('revoke', () => {
  test('refuses new work, closes the unfinished and keeps what is in flight', () => {
    const { store } = testStore()
    const waiting = open(store, '8')
    store.reserve(waiting.id)
    const held = open(store, '1')
    store.reserve(held.id)
    const flying = open(store, '1')
    store.reserve(flying.id)
    store.signing(flying.id)
    store.revoke()
    expect(store.operation(waiting.id)?.status).toBe('cancelled')
    expect(store.operation(held.id)?.status).toBe('cancelled')
    expect(store.operation(flying.id)?.status).toBe('signing')
    expect(store.pendingApprovals()).toEqual([])
    expect(
      store.begin({ id: 'op-after-revoke', argsHash: 'z', terms: termsFor('1'), termsHash: '0xff', client: 'c' }),
    ).toMatchObject({
      kind: 'refused',
      code: 'revoked',
    })
  })
})

describe('view state', () => {
  test('is bounded JSON', () => {
    const { store } = testStore()
    expect(store.viewState()).toBe('{}')
    expect(store.putViewState('{"tab":"limits"}')).toBe(true)
    expect(store.viewState()).toBe('{"tab":"limits"}')
    expect(store.putViewState(JSON.stringify({ big: 'x'.repeat(9000) }))).toBe(false)
  })
})
