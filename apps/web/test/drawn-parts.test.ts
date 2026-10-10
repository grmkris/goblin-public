import { describe, expect, it } from 'vitest'
import { DelegateResultData, PersonaAnswerData, PersonaAskData, ThreadHeadData, TopicSeedData } from '@goblin/contracts'
import { Schema } from 'effect'
import { conversationParts } from '../src/lib/conversation-parts.ts'
import { isOwnTurn, samePart } from '../src/lib/parts.ts'
import { projectSnapshot } from '../src/lib/projection.ts'

// Every fixture's data is the contract's own shape: it decodes with the schema the runtime writes it with.
const head = Schema.decodeUnknownSync(ThreadHeadData)({ thread: '12', text: 'Plan the trip', operationId: 'op-1' })
const moved = Schema.decodeUnknownSync(ThreadHeadData)({
  thread: '13',
  text: 'Compare flights',
  moved: true,
  author: 'Kris',
  operationId: 'op-2',
})
const ask = Schema.decodeUnknownSync(PersonaAskData)({
  personas: [
    { id: 1, name: 'Critic', revision: 2 },
    { id: 2, name: 'Coach', revision: 1 },
  ],
  order: 'sequence',
})
const answer = Schema.decodeUnknownSync(PersonaAnswerData)({
  persona: 1,
  name: 'Critic',
  revision: 2,
  avatar: { glyph: 'C', hue: 20 },
  operationId: 'persona:op-3:1',
  text: 'Too long.',
})
const seed = Schema.decodeUnknownSync(TopicSeedData)({
  brief: 'Japan in April',
  sources: [{ chat: '1', entryStart: 3, entryEnd: 5, excerpt: 'cherry blossoms' }],
})
const result = Schema.decodeUnknownSync(DelegateResultData)({
  delegate: '21',
  name: 'Researcher',
  status: 'done',
  text: 'Three options.',
})

const snapshot = (entries: readonly unknown[]) => projectSnapshot({ type: 'snapshot', entries, tools: [], inbox: [] })
const user = (id: number, content: string) => ({ id, kind: 'pi.user', model: [{ role: 'user', content }] })

describe('entries the app writes into a chat', () => {
  it('draws a thread head, a Persona ask and answer, a Topic brief and a Delegate result as their own parts', () => {
    const parts = conversationParts(
      snapshot([
        { id: 1, kind: 'app.topic_seed', data: seed },
        { id: 2, kind: 'app.thread_head', data: head, model: [{ role: 'user', content: '[thread]', timestamp: 7 }] },
        {
          id: 3,
          kind: 'app.persona_ask',
          data: ask,
          model: [{ role: 'user', content: '[to @Critic, then @Coach]\nIs this good?' }],
        },
        { id: 4, kind: 'app.persona', data: answer },
        { id: 5, kind: 'app.delegate_result', data: result },
      ]),
    )
    expect(parts.map((part) => part.kind)).toEqual([
      'topic-seed',
      'thread-head',
      'persona-ask',
      'persona-answer',
      'delegate-result',
    ])
    expect(parts[0]).toMatchObject({ brief: 'Japan in April', sources: [{ excerpt: 'cherry blossoms' }] })
    expect(parts[1]).toEqual({
      kind: 'thread-head',
      id: '2:0',
      thread: '12',
      text: 'Plan the trip',
      moved: false,
      at: 7,
    })
    expect(parts[2]).toMatchObject({ text: 'Is this good?', order: 'sequence', personas: [{ name: 'Critic' }, {}] })
    expect(parts[3]).toMatchObject({ name: 'Critic', avatar: { glyph: 'C', hue: 20 }, text: 'Too long.' })
    expect(parts[3]).not.toHaveProperty('operationId')
    expect(parts[4]).toMatchObject({ delegate: '21', name: 'Researcher', status: 'done', text: 'Three options.' })
  })

  it("marks a moved turn's head as moved and keeps who wrote it", () => {
    const [part] = conversationParts(snapshot([{ id: 9, kind: 'app.thread_head', data: moved }]))
    expect(part).toMatchObject({ kind: 'thread-head', thread: '13', moved: true, author: 'Kris' })
  })

  it('leaves out an entry whose data does not have its contract shape', () => {
    const parts = conversationParts(
      snapshot([
        { id: 1, kind: 'app.thread_head', data: { thread: 'not digits', text: 'x', operationId: 'op' } },
        { id: 2, kind: 'app.persona', data: { name: 'nobody' } },
        user(3, 'still here'),
      ]),
    )
    expect(parts.map((part) => [part.kind, part.id])).toEqual([['user', '3:0']])
  })

  it("counts the owner's message to Personas as the owner's turn", () => {
    const [part] = conversationParts(
      snapshot([{ id: 3, kind: 'app.persona_ask', data: ask, model: [{ role: 'user', content: 'Hi' }] }]),
    )
    expect(part !== undefined && isOwnTurn(part)).toBe(true)
  })

  it('draws an unchanged app entry once across batches', () => {
    const entries = [{ id: 2, kind: 'app.thread_head', data: head }]
    const [first] = conversationParts(snapshot(entries))
    const [again] = conversationParts(snapshot(structuredClone(entries)))
    expect(first !== undefined && again !== undefined && samePart(first, again)).toBe(true)
  })
})

describe('a turn moved out of the chat', () => {
  it('hides the entries a later entry omits, and shows the head in their place', () => {
    const parts = conversationParts(
      snapshot([
        user(1, 'before'),
        user(2, 'Compare flights'),
        { id: 3, kind: 'pi.assistant', model: [{ role: 'assistant', content: 'Working on it', stopReason: 'stop' }] },
        {
          id: 4,
          kind: 'app.thread_head',
          data: moved,
          edits: [
            { target: 2, action: 'omit' },
            { target: 3, action: 'omit' },
          ],
        },
        user(5, 'after'),
      ]),
    )
    expect(parts.map((part) => [part.kind, part.id])).toEqual([
      ['user', '1:0'],
      ['thread-head', '4:0'],
      ['user', '5:0'],
    ])
  })
})
