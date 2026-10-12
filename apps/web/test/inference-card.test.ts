import { describe, expect, it } from 'vitest'
import type { ModelChoice, ModelOption } from '@goblin/contracts'
import { waysOf } from '../src/components/inference-card.tsx'

const option = (id: string): ModelOption => ({
  id,
  label: id,
  route: 'x',
  note: '',
  images: false,
  contextWindow: 131_072,
})

describe('how goblin pays for its model (ADR 0047)', () => {
  it("offers the plan's Credits on the default model, then each paid route the stage sells, in its order", () => {
    const choice: ModelChoice = {
      current: 'qwen3.8-flash',
      default: 'deepseek-v4.1-flash',
      options: [option('deepseek-v4.1-flash'), option('qwen3.8-flash'), option('paid:tempo'), option('paid:goblin')],
    }
    expect(waysOf(choice).map((way) => [way.model, way.title])).toEqual([
      ['deepseek-v4.1-flash', 'Included in your plan'],
      ['paid:tempo', 'Pay per call: Tempo'],
      ['paid:goblin', 'Pay per call: goblin'],
    ])
    expect(waysOf({ ...choice, options: choice.options.slice(0, 2) })).toHaveLength(1)
  })
})
