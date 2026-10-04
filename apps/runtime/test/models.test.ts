import { describe, expect, it } from 'vitest'
import { InvalidInput } from '../src/http/errors.ts'
import { type ChoiceLedger, ModelPicker, modelOptions } from '../src/models.ts'

/** The stored pick in memory: the picker depends on the ledger, not on SQLite. */
const ledger = (initial?: string): ChoiceLedger & { readonly stored: () => string | undefined } => {
  let value = initial
  return {
    get: () => value,
    set: (modelId) => {
      value = modelId
    },
    stored: () => value,
  }
}

describe('offered models (unit)', () => {
  it('puts the default first, drops duplicates and blanks, and offers unknown names text-only', () => {
    const options = modelOptions(' qwen3.8-flash, gemini-3.8-flash,,qwen3.8-flash,mystery-1 ', 'gemini-3.8-flash')
    expect(options.map((option) => option.id)).toEqual(['gemini-3.8-flash', 'qwen3.8-flash', 'mystery-1'])
    expect(options[1]).toMatchObject({ label: 'Qwen 3.8 Flash', route: 'Alibaba Cloud', images: true })
    expect(options[2]).toEqual({ id: 'mystery-1', label: 'mystery-1', route: 'Other', note: '', images: false })
    expect(modelOptions(undefined, 'gemini-3.8-flash').map((option) => option.id)).toEqual(['gemini-3.8-flash'])
  })
})

describe('the user model pick (unit)', () => {
  const options = modelOptions('qwen3.8-flash,glm-5.3', 'gemini-3.8-flash')

  it('answers with the default until the user picks, then with the pick', () => {
    const store = ledger()
    const picker = new ModelPicker(store, options)
    expect(picker.choice()).toMatchObject({ current: 'gemini-3.8-flash', default: 'gemini-3.8-flash' })
    expect(picker.choose('glm-5.3', 1).current).toBe('glm-5.3')
    expect(store.stored()).toBe('glm-5.3')
  })

  it('refuses a model the deployment does not offer and keeps the old pick', () => {
    const store = ledger('qwen3.8-flash')
    const picker = new ModelPicker(store, options)
    expect(() => picker.choose('gpt-6.1-sol', 1)).toThrow(InvalidInput)
    expect(picker.current()).toBe('qwen3.8-flash')
  })

  it('falls back to the default when the stored pick is no longer offered', () => {
    expect(new ModelPicker(ledger('deepseek-v4-pro'), options).current()).toBe('gemini-3.8-flash')
  })
})
