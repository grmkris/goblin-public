import { RunAttribute, type FlowEvent } from '@goblin/contracts/telemetry'
import { afterEach, describe, expect, it } from 'vitest'
import { RunTelemetry, flowOf, flowRunEvent } from '../src/telemetry/events.ts'
import { RunLedger } from '../src/telemetry/ledger.ts'
import { sanitizeAttributes } from '../src/telemetry/safety.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const ledgerFixture = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  const ledger = new RunLedger(db)
  return { ledger, telemetry: new RunTelemetry([ledger], (id) => ledger.read(id)) }
}

const reply: FlowEvent = {
  flow: 'reply',
  via: 'app',
  actor: 'owner',
  chat: '12',
  parentChat: '1',
  topic: 2,
  operationId: 'owner:op-7',
  parentOperation: 'owner:op-6',
  count: 2,
  personaOrder: 'sequence',
  synthesize: false,
  status: 'ok',
  ms: 41,
}

describe('flow attributes', () => {
  it('keep only allowlisted keys with values of their closed set or id shape', () => {
    const text = 'Please move my notes about the divorce into a thread'
    expect(
      sanitizeAttributes({
        [RunAttribute.flow]: 'reply',
        [RunAttribute.flowVia]: 'telegram',
        [RunAttribute.flowStatus]: 'refused',
        [RunAttribute.actor]: 'persona',
        [RunAttribute.origin]: 'routine',
        [RunAttribute.chat]: '12',
        [RunAttribute.parentChat]: '1',
        [RunAttribute.topic]: 3,
        [RunAttribute.parentOperation]: 'owner:op-6',
        [RunAttribute.count]: 0,
        [RunAttribute.personaOrder]: 'parallel',
        [RunAttribute.synthesize]: true,
        'goblin.message': text,
      }),
    ).toEqual({
      [RunAttribute.flow]: 'reply',
      [RunAttribute.flowVia]: 'telegram',
      [RunAttribute.flowStatus]: 'refused',
      [RunAttribute.actor]: 'persona',
      [RunAttribute.origin]: 'routine',
      [RunAttribute.chat]: '12',
      [RunAttribute.parentChat]: '1',
      [RunAttribute.topic]: 3,
      [RunAttribute.parentOperation]: 'owner:op-6',
      [RunAttribute.count]: 0,
      [RunAttribute.personaOrder]: 'parallel',
      [RunAttribute.synthesize]: true,
    })
  })

  it('drop free text and out-of-shape values instead of coercing them', () => {
    const text = 'Please move my notes about the divorce into a thread'
    expect(
      sanitizeAttributes({
        [RunAttribute.flow]: text,
        [RunAttribute.flowVia]: 'email',
        [RunAttribute.flowStatus]: 'started',
        [RunAttribute.actor]: 'Kristjan',
        [RunAttribute.origin]: text,
        [RunAttribute.chat]: 'chat twelve',
        [RunAttribute.parentChat]: 12,
        [RunAttribute.topic]: 0,
        [RunAttribute.parentOperation]: text,
        [RunAttribute.count]: 1.5,
        [RunAttribute.personaOrder]: 'random',
        [RunAttribute.synthesize]: 'yes',
      }),
    ).toEqual({})
  })
})

describe('flow events in the run ledger', () => {
  it('round-trip a flow step through the ledger into its operation timeline', () => {
    const { ledger, telemetry } = ledgerFixture()
    const event = flowRunEvent(reply, 'flow:1', 1_000)
    telemetry.record(event)

    expect(ledger.read('flow:1')).toMatchObject({ kind: 'flow', status: 'ok', operationId: 'owner:op-7' })
    expect(flowOf(ledger.read('flow:1') ?? event)).toEqual(reply)
    expect(ledger.forOperation('owner:op-7').map(flowOf)).toEqual([reply])
    expect(ledger.skipped).toBe(0)
  })

  it('keep a refusal and a safe error code, and map them to run statuses', () => {
    const { ledger, telemetry } = ledgerFixture()
    const refused: FlowEvent = { flow: 'move', via: 'app', actor: 'owner', chat: '12', status: 'refused' }
    const failed: FlowEvent = {
      flow: 'subagent_spawn',
      via: 'tool',
      actor: 'agent',
      status: 'error',
      errorType: 'Internal',
    }
    telemetry.record(flowRunEvent(refused, 'flow:2', 2_000))
    telemetry.record(flowRunEvent(failed, 'flow:3', 3_000))

    expect(ledger.read('flow:2')?.status).toBe('blocked')
    expect(ledger.read('flow:3')?.status).toBe('error')
    expect(flowOf(ledger.read('flow:2') ?? flowRunEvent(refused, 'x', 0))).toEqual(refused)
    expect(flowOf(ledger.read('flow:3') ?? flowRunEvent(failed, 'x', 0))).toEqual(failed)
  })

  it('leave a refused step out of problems unless all are asked for, and keep a failed one in', () => {
    const { ledger, telemetry } = ledgerFixture()
    const refused: FlowEvent = { flow: 'move', via: 'app', actor: 'owner', chat: '12', status: 'refused' }
    const failed: FlowEvent = { flow: 'start', via: 'app', actor: 'owner', status: 'error', errorType: 'Internal' }
    telemetry.record(flowRunEvent(refused, 'flow:4', 4_000))
    telemetry.record(flowRunEvent(failed, 'flow:5', 5_000))
    telemetry.record({
      id: 'task:9',
      kind: 'error',
      status: 'error',
      startedAt: 6_000,
      endedAt: 6_000,
      attributes: { [RunAttribute.taskKind]: 'subagent.relay' },
    })

    expect(ledger.problems(0, 10).map((event) => event.id)).toEqual(['task:9', 'flow:5'])
    expect(ledger.problems(0, 10, true).map((event) => event.id)).toEqual(['task:9', 'flow:5', 'flow:4'])
  })

  it('reads no flow from another kind of event', () => {
    expect(flowOf({ id: 'turn:1', kind: 'turn.submitted', status: 'ok', startedAt: 1, attributes: {} })).toBeUndefined()
  })
})
