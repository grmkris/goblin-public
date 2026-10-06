import { describe, expect, it } from 'vitest'
import { Internal, UpstreamMcp } from '../src/http/errors.ts'
import { describeError, failureAttributes } from '../src/telemetry/attributes.ts'

describe('a failure as one line (unit, ADR 0024)', () => {
  it('names what failed and why', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError(new TypeError('x is not a function'))).toBe('TypeError: x is not a function')
    expect(describeError(new UpstreamMcp({ serverId: 'myplan', reason: 'timeout' }))).toBe(
      'UpstreamMcp (serverId: myplan, reason: timeout)',
    )
    expect(describeError(new Internal({ reason: 'unexpected' }))).toBe('Internal (reason: unexpected)')
    expect(describeError('empty line')).toBe('empty line')
  })

  it('reads what Workers RPC hands over: a plain object, never [object Object]', () => {
    expect(describeError({ _tag: 'BudgetExhausted', reason: 'daily' })).toBe('BudgetExhausted (reason: daily)')
    expect(describeError({ message: 'socket closed' })).toBe('socket closed')
    expect(describeError({ payload: { text: 'secret' } })).toBe('error without a message')
  })

  it('follows the cause chain and stays bounded', () => {
    expect(describeError(new Error('summary failed', { cause: new Error('empty line') }))).toBe(
      'summary failed, caused by empty line',
    )
    expect(describeError(new Error('x'.repeat(1000)))).toHaveLength(300)
    expect(failureAttributes({ _tag: 'UpstreamMcp', reason: 'timeout' })).toMatchObject({
      'error.type': 'UpstreamMcp:timeout',
      'goblin.error': 'UpstreamMcp (reason: timeout)',
    })
  })
})
