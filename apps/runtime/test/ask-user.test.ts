import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { QuestionSpec } from '@purrable/contracts'
import { askUserExtension } from '../src/pi/ask-user.ts'

const askUser = askUserExtension.tools?.find((tool) => tool.name === 'ask_user')
const ask = (questions: readonly QuestionSpec[]) => {
  if (askUser === undefined) throw new Error('ask_user is not registered')
  // SAFETY: ask_user reads neither the execution API nor the invocation context.
  return askUser.execute({ questions }, {} as never, {} as never)
}
const decodeQuestions = Schema.decodeUnknownSync(Schema.Array(QuestionSpec))

describe('ask_user (unit)', () => {
  it('records the questions, shows them as plain text, and ends the run without another model call', async () => {
    const result = await ask([
      {
        id: 'when',
        prompt: 'When should the trip start?',
        kind: 'single',
        options: [
          { id: 'fri', label: 'Friday' },
          { id: 'sat', label: 'Saturday', description: 'cheaper flights' },
        ],
        allowOther: true,
      },
      { id: 'who', prompt: 'Who is coming?', kind: 'text' },
    ])
    expect(result.control).toEqual({ terminate: true })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([
      {
        type: 'text',
        text: [
          'Asked the owner:',
          '1. When should the trip start?',
          '   - Friday',
          '   - Saturday (cheaper flights)',
          '   - or something else',
          '2. Who is coming?',
          'Their answers will arrive as their next message.',
        ].join('\n'),
      },
    ])
    expect(result.details).toMatchObject({ kind: 'question' })
    // SAFETY: the matcher above has just checked that details is an object.
    const details = result.details as { readonly questions: unknown }
    expect(decodeQuestions(details.questions)).toEqual([
      {
        id: 'when',
        prompt: 'When should the trip start?',
        kind: 'single',
        options: [
          { id: 'fri', label: 'Friday' },
          { id: 'sat', label: 'Saturday', description: 'cheaper flights' },
        ],
        allowOther: true,
      },
      { id: 'who', prompt: 'Who is coming?', kind: 'text' },
    ])
  })
  it('refuses a choice without two options, or repeated ids, and lets the model try again', async () => {
    const result = await ask([
      { id: 'a', prompt: 'Pick one', kind: 'single', options: [{ id: 'x', label: 'Only' }] },
      {
        id: 'a',
        prompt: 'Again',
        kind: 'multi',
        options: [
          { id: 'y', label: 'Y' },
          { id: 'y', label: 'Also Y' },
        ],
      },
    ])
    expect(result.isError).toBe(true)
    expect(result.control).toBeUndefined()
    const text = JSON.stringify(result.content)
    expect(text).toContain('Question ids repeat.')
    expect(text).toContain('needs at least two options')
    expect(text).toContain('repeats an option id')
  })
})
