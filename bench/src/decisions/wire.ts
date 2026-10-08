import { Schema } from 'effect'
import type { Answers, Fixture, Questions, Usage } from './schema.ts'
import { questionsFor, prompt } from './questions.ts'

const Obj = Schema.Record(Schema.String, Schema.Unknown)
const record = (value: unknown) => Schema.decodeUnknownSync(Obj)(value)
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
export type Packet = { readonly state: string; readonly questions: Questions }

export function packet(fixtures: readonly Fixture[], selected = fixtures): Packet {
  return {
    state: JSON.stringify({
      instructions: prompt,
      cases: fixtures.map((fixture) => ({ id: fixture.id, state: fixture.state })),
    }),
    questions: Object.fromEntries(
      selected.flatMap((fixture) =>
        Object.entries(questionsFor(fixture)).map(([name, question]) => [
          fixture.id + '.' + name,
          { ...question, instructions: 'For case ' + fixture.id + ': ' + question.instructions },
        ]),
      ),
    ),
  }
}
export function typedBody(model: string, data: Packet, gateway = false) {
  return {
    model,
    state: data.state,
    questions: Object.fromEntries(
      Object.entries(data.questions).map(([name, question]) => [
        name,
        {
          type: gateway && question.type === 'noul' ? 'boolean' : question.type,
          instructions: question.instructions,
          ...(question.type === 'noul' ? {} : { criteria: question.criteria }),
        },
      ]),
    ),
  }
}
export function openaiBody(data: Packet) {
  return {
    model: 'gpt-6-luna',
    input: data.state,
    questions: Object.entries(data.questions).map(([name, question]) => ({
      name,
      type: question.type === 'noul' ? 'predicate' : question.type,
      instructions: question.instructions,
      ...(question.type === 'choice'
        ? { choices: question.options.map((value) => ({ value, description: value })) }
        : {}),
      ...(question.type === 'score'
        ? {
            levels: question.options.map((label, index) => ({
              label,
              description: Object.values(question.criteria)[index] ?? label,
            })),
          }
        : {}),
    })),
  }
}
export function chatBody(model: string, data: Packet, output: number) {
  return {
    model,
    temperature: 0,
    enable_thinking: false,
    max_tokens: output,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          prompt +
          ' Return exactly {"answers":{"question-id":{"offered-option":probability,...},...}}. Every question and every option must be included. Each probability map sums to 1. No text outside JSON.',
      },
      { role: 'user', content: JSON.stringify(data) },
    ],
  }
}

function distribution(raw: unknown, options: readonly string[], score: boolean): Readonly<Record<string, number>> {
  const item = record(raw)
  let value: unknown = item['probabilities'] ?? item
  if (Array.isArray(value)) {
    value = Object.fromEntries(
      value.map((entry) => {
        const fields = record(entry)
        return [String(fields['label'] ?? fields['value']), fields['probability']]
      }),
    )
  }
  const fields = record(value)
  const remapped =
    score && Object.keys(fields).every((key) => /^\d+$/u.test(key))
      ? Object.fromEntries(
          Object.entries(fields).map(([key, probability]) => [options[Number(key)] ?? 'invalid', probability]),
        )
      : fields
  if (Object.keys(remapped).length !== options.length || options.some((option) => !(option in remapped)))
    throw new Error('Incomplete probability distribution')
  const output = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  )(remapped)
  const total = Object.values(output).reduce((sum, probability) => sum + probability, 0)
  if (Math.abs(total - 1) > 0.02) throw new Error('Probability distribution is not normalized')
  return Object.fromEntries(Object.entries(output).map(([key, probability]) => [key, probability / total]))
}
function predicate(raw: unknown): Readonly<Record<string, number>> {
  const item = typeof raw === 'number' ? { probability: raw } : record(raw)
  const probability = item['probability'] ?? item['noul']
  if (probability === undefined) return distribution(raw, ['yes', 'no'], false)
  const yes = Schema.decodeUnknownSync(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })))(probability)
  return { yes, no: 1 - yes }
}
export function decodeAnswers(body: unknown, questions: Questions): Answers {
  const root = record(body)
  const result = root['result'] === undefined ? root : record(root['result'])
  const raw = result['answers']
  const answers = Array.isArray(raw)
    ? Object.fromEntries(
        raw.map((item) => {
          const fields = record(item)
          return [Schema.decodeUnknownSync(Schema.String)(fields['name']), fields]
        }),
      )
    : record(raw)
  if (Object.keys(answers).length !== Object.keys(questions).length) throw new Error('Unexpected question count')
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => [
      name,
      question.type === 'noul'
        ? predicate(answers[name])
        : distribution(answers[name], question.options, question.type === 'score'),
    ]),
  )
}
export function usageOf(body: unknown): Usage | undefined {
  const root = record(body)
  const result = root['result'] === undefined ? root : record(root['result'])
  if (result['usage'] === undefined) return undefined
  const usage = record(result['usage'])
  const input = count(usage['inputTokens'] ?? usage['input_tokens'] ?? usage['prompt_tokens'] ?? usage['promptTokens'])
  const output = count(
    usage['outputTokens'] ?? usage['output_tokens'] ?? usage['completion_tokens'] ?? usage['completionTokens'],
  )
  return input === undefined || output === undefined ? undefined : { input, output }
}
export function chatAnswer(body: unknown): unknown {
  const root = record(body)
  const choices = Schema.decodeUnknownSync(Schema.Array(Obj))(root['choices'])
  const message = record(choices[0]?.['message'])
  const content = Schema.decodeUnknownSync(Schema.String)(message['content'])
  const parsed: unknown = JSON.parse(content)
  return parsed
}
