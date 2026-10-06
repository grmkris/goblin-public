import { describe, expect, it } from 'vitest'
import { mismatches, plainJson, schemaProblems } from '../src/agent-apps/json.ts'
import { readManifest, requestedPowers, storedManifest } from '../src/agent-apps/manifest.ts'
import { backoff, lastSlot, nextSlot } from '../src/agent-apps/jobs.ts'
import { AppQueues, problemText } from '../src/agent-apps/queue.ts'
import { InvalidInput } from '../src/http/errors.ts'

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const counter = {
  name: 'counter',
  title: 'Counter',
  description: 'Counts.',
  state: { schema: object({ count: { type: 'integer' } }), initial: { count: 0 }, migrate: false },
  actions: {
    add: {
      description: 'Add.',
      input: object({ by: { type: 'integer', minimum: 1 } }),
      agent: true,
      prepare: false,
      run: true,
    },
  },
  views: { total: { description: 'The count.', input: object({}), select: true } },
  egress: [],
  uses: { tools: [], apps: [], llm: false, notify: false },
  schedules: [],
}

describe('app schemas', () => {
  it('accept what s.* builds and refuse references, patterns and unknown types', () => {
    expect(schemaProblems(counter.state.schema, 'state')).toEqual([])
    expect(schemaProblems({ $ref: '#/x' }, 'state')).toEqual(['state: "$ref" is not supported'])
    expect(schemaProblems(object({ a: { type: 'string', pattern: '(a+)+$' } }), 'in')).toEqual([
      'in.a: "pattern" is not supported',
    ])
    expect(schemaProblems({ type: 'date' }, 'x')).toEqual(['x: unknown type'])
  })
  it('say where a value does not fit', () => {
    expect(mismatches(counter.state.schema, { count: 1 })).toEqual([])
    expect(mismatches(counter.state.schema, { count: 'one' })[0]).toContain('/count')
    expect(mismatches(counter.state.schema, { count: 1, extra: true }).length).toBeGreaterThan(0)
  })
  it('take values only as plain JSON within their size', () => {
    expect(plainJson({ a: 1, b: undefined }, 100, 'x')).toEqual({ a: 1 })
    expect(() => plainJson({ big: 'x'.repeat(200) }, 100, 'x')).toThrow()
    expect(() => plainJson({ n: 1n }, 100, 'x')).toThrow(InvalidInput)
  })
})

const problems = (described: unknown, app = 'counter') => {
  const read = readManifest(described, app)
  return 'problems' in read ? read.problems : []
}

describe('manifests', () => {
  it('read one whose name, members and initial state fit', () => {
    expect(readManifest(counter, 'counter')).toHaveProperty('manifest')
  })
  it('list every problem otherwise', () => {
    expect(problems(counter, 'tally')).toEqual(['The app is named "tally"; its code says "counter".'])
    expect(problems({ ...counter, views: { 'Bad-Name': counter.views.total } })[0]).toContain('camelCase')
    expect(problems({ ...counter, state: { ...counter.state, initial: { count: 'zero' } } })[0]).toContain(
      'state.initial',
    )
    expect(problems({ ...counter, actions: {}, views: {} })).toEqual(['An app needs at least one action or view.'])
    expect(problems({ ...counter, actions: { add: { ...counter.actions.add, run: false } } })[0]).toContain('needs run')
    expect(problems({ name: 'counter' })[0]).toContain('default export')
  })
  it('read the powers an app asks for, and refuse hosts, tools and apps that are not names', () => {
    const asking = {
      ...counter,
      egress: ['api.example.com'],
      uses: { tools: ['notes/list'], apps: ['reading-list'], llm: true, notify: false },
    }
    const read = readManifest(asking, 'counter')
    expect('manifest' in read ? requestedPowers(read.manifest) : read).toEqual([
      { kind: 'egress', target: 'api.example.com' },
      { kind: 'tool', target: 'notes/list' },
      { kind: 'app', target: 'reading-list' },
      { kind: 'llm', target: '*' },
    ])
    expect(problems({ ...counter, egress: ['https://api.example.com/x', '10.0.0.1', 'localhost'] })).toEqual([
      'egress: "https://api.example.com/x" is not a host name like api.example.com (no scheme, path or IP address).',
      'egress: "10.0.0.1" is not a host name like api.example.com (no scheme, path or IP address).',
      'egress: "localhost" is not a host name like api.example.com (no scheme, path or IP address).',
    ])
    expect(problems({ ...asking, uses: { ...asking.uses, tools: ['list'], apps: ['counter'] } })).toEqual([
      'uses.tools: "list" is not "<server>/<tool>".',
      'uses.apps: an app does not call itself.',
    ])
  })
  it('read a manifest stored before powers and schedules as asking for none', () => {
    const { egress: _egress, uses: _uses, schedules: _schedules, ...before } = counter
    expect(storedManifest(JSON.stringify(before))).toMatchObject({
      egress: [],
      uses: { tools: [], apps: [], llm: false, notify: false },
      schedules: [],
    })
  })
  it('refuse schedules that run no action, too often, at a time only daily ones have, or with the wrong input', () => {
    const schedule = { action: 'add', every: '1h', at: null, input: { by: 1 } }
    expect(readManifest({ ...counter, schedules: [schedule] }, 'counter')).toHaveProperty('manifest')
    expect(
      problems({
        ...counter,
        schedules: [
          { ...schedule, every: '5m' },
          { ...schedule, action: 'total' },
          { ...schedule, action: 'add', at: '07:00' },
        ],
      }),
    ).toEqual([
      'schedules: one schedule per action.',
      'schedules (add): every is one of 15m, 30m, 1h, 3h, 6h, 12h, 1d.',
      'schedules (total): no action total (a schedule runs an action, not a view).',
      "schedules (add): `at` is only for every: '1d'.",
    ])
    expect(problems({ ...counter, schedules: [{ ...schedule, every: '1d', at: '7:00', input: { by: 0 } }] })).toEqual([
      'schedules (add): at is "HH:MM" (UTC).',
      'schedules (add) input: /by: must be >= 1',
    ])
  })
})

/** A time on 2026-10-06, UTC. */
const at = (time: string) => Date.parse(`2026-10-06T${time}:00Z`)

describe('app schedules', () => {
  it('fall on the period from midnight UTC, a daily one at its time', () => {
    expect(nextSlot({ every: '15m', at: null }, at('10:07'))).toBe(at('10:15'))
    expect(nextSlot({ every: '15m', at: null }, at('10:15'))).toBe(at('10:30'))
    expect(nextSlot({ every: '6h', at: null }, at('10:07'))).toBe(at('12:00'))
    expect(nextSlot({ every: '1d', at: '06:30' }, at('10:07'))).toBe(Date.parse('2026-10-07T06:30:00Z'))
    expect(nextSlot({ every: '1d', at: '06:30' }, at('05:00'))).toBe(at('06:30'))
  })
  it('catch up only the newest slot a late run missed', () => {
    expect(lastSlot({ every: '1h', at: null }, at('13:59'))).toBe(at('13:00'))
    expect(lastSlot({ every: '1d', at: '06:30' }, at('06:30'))).toBe(at('06:30'))
  })
  it('wait longer after each failure, at most six hours', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((failures) => backoff(failures) / 60_000)).toEqual([
      15, 30, 60, 120, 240, 360, 360,
    ])
  })
})

describe('app queues', () => {
  it('run one app’s changes in arrival order, even after a failure', async () => {
    const queues = new AppQueues()
    const order: string[] = []
    const slow = queues.run('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('first')
      throw new Error('boom')
    })
    const next = queues.run('a', async () => order.push('second'))
    await expect(slow).rejects.toThrow('boom')
    await next
    expect(order).toEqual(['first', 'second'])
  })
  it('turn tagged errors into one readable line', () => {
    expect(problemText(new InvalidInput({ reason: 'input: /by must be >= 1' }))).toBe(
      'InvalidInput — reason: input: /by must be >= 1',
    )
  })
})
