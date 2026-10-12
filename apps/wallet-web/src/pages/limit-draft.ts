import { usdToMicros } from '@goblin/wallet/amounts'

const USD = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/u

export interface LimitDraft {
  readonly perCall: string
  readonly perHour: string
  readonly perWeek: string
}

export interface LimitProblem {
  readonly field: keyof LimitDraft
  readonly message: string
}

/** Each limit is a positive amount, and a call cannot exceed the hour, nor the hour the week. */
export function checkLimits(draft: LimitDraft): readonly LimitProblem[] {
  const problems: LimitProblem[] = []
  for (const field of ['perCall', 'perHour', 'perWeek'] as const) {
    const value = draft[field]
    if (!USD.test(value) || usdToMicros(value) === 0n)
      problems.push({ field, message: 'Enter an amount like 5 or 0.50.' })
  }
  if (problems.length > 0) return problems
  if (usdToMicros(draft.perCall) > usdToMicros(draft.perHour))
    problems.push({ field: 'perCall', message: 'A single payment cannot be more than the hourly limit.' })
  if (usdToMicros(draft.perHour) > usdToMicros(draft.perWeek))
    problems.push({ field: 'perHour', message: 'The hourly limit cannot be more than the weekly limit.' })
  return problems
}
