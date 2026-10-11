import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { RoutineDefinition, handOverOf } from './routines.ts'

const BASE = {
  title: 'Inbox',
  trigger: { kind: 'event', connectionId: 'sidequest', name: 'sidequest.inbox', arguments: {} },
  timezone: 'UTC',
} as const
const GOBLIN = {
  kind: 'goblin',
  instruction: 'Read the job and tell me what to do.',
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
} as const
const decodes = (value: unknown): boolean => Option.isSome(Schema.decodeUnknownOption(RoutineDefinition)(value))

describe('a routine tells, hands over, or both (ADR 0041)', () => {
  it('takes Tell me alone, a hand-over alone, or both', () => {
    expect(decodes({ ...BASE, tellMe: { on: true, telegram: false }, handTo: { kind: 'none' } })).toBe(true)
    expect(decodes({ ...BASE, tellMe: { on: false, telegram: false }, handTo: GOBLIN })).toBe(true)
    expect(decodes({ ...BASE, tellMe: { on: true, telegram: true }, handTo: GOBLIN })).toBe(true)
  })

  it('refuses a routine that does nothing, and Telegram without Tell me', () => {
    expect(decodes({ ...BASE, tellMe: { on: false, telegram: false }, handTo: { kind: 'none' } })).toBe(false)
    expect(decodes({ ...BASE, tellMe: { on: false, telegram: true }, handTo: GOBLIN })).toBe(false)
  })

  it('names the hand-over only when the work is given to someone', () => {
    const told = Schema.decodeUnknownSync(RoutineDefinition)({
      ...BASE,
      tellMe: { on: true, telegram: false },
      handTo: { kind: 'none' },
    })
    expect(handOverOf(told)).toBeUndefined()
    const handed = Schema.decodeUnknownSync(RoutineDefinition)({
      ...BASE,
      tellMe: { on: false, telegram: false },
      handTo: GOBLIN,
    })
    expect(handOverOf(handed)?.instruction).toBe(GOBLIN.instruction)
  })
})
