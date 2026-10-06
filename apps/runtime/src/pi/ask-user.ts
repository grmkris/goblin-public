import { defineExtension, section } from '@earendil-works/pi-durable'
import { type JsonObject, QuestionSpec } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { typedTool } from './typed-tool.ts'

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const Option = Schema.Struct({
  id: Id,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
})
const Question = Schema.Struct({
  id: Id,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  kind: Schema.Literals(['single', 'multi', 'text']),
  options: Schema.optionalKey(Schema.Array(Option).check(Schema.isMaxLength(8))),
  allowOther: Schema.optionalKey(Schema.Boolean),
})
type Question = typeof Question.Type

/** What is wrong with a set of questions the schema alone cannot catch: option counts and duplicate ids. */
function questionProblems(questions: readonly Question[]): string[] {
  const problems: string[] = []
  if (new Set(questions.map((question) => question.id)).size !== questions.length) problems.push('Question ids repeat.')
  for (const question of questions) {
    const options = question.options ?? []
    if (question.kind !== 'text' && options.length < 2)
      problems.push(`"${question.prompt}" is a choice and needs at least two options.`)
    if (new Set(options.map((option) => option.id)).size !== options.length)
      problems.push(`"${question.prompt}" repeats an option id.`)
  }
  return problems
}

const Questions = Schema.Array(Question).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(5),
  Schema.makeFilter((questions) => {
    const problems = questionProblems(questions)
    return problems.length === 0 ? true : `Not asked. ${problems.join(' ')}`
  }),
)

/** The questions as numbered plain text: what the model sees, and what a text-only channel can show the owner. */
function questionText(questions: readonly Question[]): string {
  return questions
    .map((question, index) => {
      const lines = [`${index + 1}. ${question.prompt}${question.kind === 'multi' ? ' (choose any)' : ''}`]
      if (question.kind !== 'text')
        for (const option of question.options ?? [])
          lines.push(`   - ${option.label}${option.description === undefined ? '' : ` (${option.description})`}`)
      if (question.allowOther === true && question.kind !== 'text') lines.push('   - or something else')
      return lines.join('\n')
    })
    .join('\n')
}

/** The JSON form of a question, without absent fields, matching the `QuestionSpec` contract. */
const spec = (question: Question): QuestionSpec & JsonObject => ({
  id: question.id,
  prompt: question.prompt,
  kind: question.kind,
  ...(question.options === undefined
    ? {}
    : {
        options: question.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      }),
  ...(question.allowOther === undefined ? {} : { allowOther: question.allowOther }),
})

const ASKING = [
  'When you cannot continue without a decision or a missing detail from the owner, ask with `ask_user` instead of in',
  'prose: short questions, with choices wherever you can offer them. Call it on its own and stop; the answers arrive',
  'as their next message. Ask only for real decisions, never to confirm something you were already asked to do.',
].join(' ')

/**
 * `ask_user`: the agent's structured questions to the owner. The tool records them and ends the run (`terminate`), so
 * no model call waits on a person; the answer is an ordinary next message, from the web card or any other channel.
 */
export function askingExtension(
  onQuestion?: (session: string, callId: string, questions: readonly QuestionSpec[]) => Promise<void>,
) {
  return defineExtension({
    name: onQuestion === undefined ? 'goblin.ask' : 'goblin.routine-ask',
    sections: [section('asking', () => ASKING)],
    tools: [
      typedTool({
        name: 'ask_user',
        description:
          'Ask the owner one to five short questions when you cannot continue without their decision or a missing detail. Offer 2-8 options for a choice. Call it alone, then stop: their answers arrive as their next message.',
        input: Schema.Struct({ questions: Questions }),
        output: Schema.Struct({ asked: Schema.Array(QuestionSpec) }),
        replay: 'safe',
        execute: async ({ questions }, api) => {
          const asked = questions.map(spec)
          if (onQuestion !== undefined) await onQuestion(String(api.conversationId), api.callId, asked)
          return { asked }
        },
        text: (_asked, { questions }) =>
          `Asked the owner:\n${questionText(questions)}\nTheir answers will arrive as their next message.`,
        details: (_asked, { questions }) => ({ kind: 'question', questions: questions.map(spec) }),
        terminate: () => true,
      }),
    ],
  })
}
export const askUserExtension = askingExtension()
