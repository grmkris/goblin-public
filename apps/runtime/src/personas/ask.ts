import type { TextContent } from '@earendil-works/pi-ai'
import type { PersonaAskData } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from '../clock.ts'
import { ChatOperations, Chats, Conversations } from '../chats/service.ts'
import { InvalidInput, NotFound, attempt, toAppError } from '../http/errors.ts'
import { conversationId } from '../pi/context.ts'
import { PiSessions } from '../pi/sessions.ts'
import type { FrozenPersona } from '../pi/persona-turn.ts'
import { AgentInput } from '../runtime/input.ts'
import { Invocations, Personas } from './service.ts'

/** The owner's content with the Personas it went to named in front, as the model of the chat reads it. */
export function addressedTo(names: readonly string[], content: string | TextContent[]): string | TextContent[] {
  const tag = `[to ${names.map((name) => `@${name}`).join(', ')}] `
  if (typeof content === 'string') return `${tag}${content}`
  const [first, ...rest] = content
  return first === undefined
    ? [{ type: 'text', text: tag.trimEnd() }]
    : [{ ...first, text: `${tag}${first.text}` }, ...rest]
}

/** Persona `id` at `revision`, frozen for a turn: its words, its setup, and its model when offered. */
export const frozenAt = (id: number, revision: number) =>
  Effect.gen(function* () {
    const personas = yield* Personas
    const { name, avatar, role, instructions, setup, model } = yield* personas.revision(id, revision)
    const offered = model !== undefined && (yield* personas.offers(model))
    return {
      id,
      name,
      revision,
      avatar,
      role,
      instructions,
      setup,
      ...(offered ? { model } : {}),
    } satisfies FrozenPersona
  })

/** The tagged Personas as they are now, each at its current revision; one that is gone or archived refuses the send. */
const freeze = (ids: readonly number[]) =>
  Effect.gen(function* () {
    const personas = yield* Personas
    const active = yield* personas.active
    return yield* Effect.forEach([...new Set(ids)], (id) =>
      Effect.gen(function* () {
        const persona = active.find((each) => each.id === id)
        if (persona === undefined) return yield* new InvalidInput({ reason: `composer:persona:${String(id)}` })
        const { name, revision, avatar, role, instructions, setup, model } = persona
        const offered = (yield* personas.offers(model)) && model !== undefined
        return {
          id,
          name,
          revision,
          avatar,
          role,
          instructions,
          ...(offered ? { model } : {}),
          setup,
        } satisfies FrozenPersona
      }),
    )
  })

type Ask = {
  readonly thread: string
  readonly operationId: string
}

/** The passive `app.persona_ask` entry: the owner's message, addressed to the Personas it went to. */
const askEntry = (
  frozen: readonly FrozenPersona[],
  order: 'parallel' | 'sequence',
  content: string | TextContent[],
  now: number,
) => {
  const data = {
    personas: frozen.map(({ id, name, revision }) => ({ id, name, revision })),
    order,
  } satisfies PersonaAskData
  const names = frozen.map(({ name }) => name)
  return {
    kind: 'app.persona_ask',
    data,
    model: [{ role: 'user' as const, content: addressedTo(names, content), timestamp: now * 1000 }],
  }
}

/**
 * The owner tagged Personas: each answers once, attributed, in this chat, and Goblin does not (ADR 0033). Admitted
 * once per operation (`ChatOperations.admit`, under the chat's lock): record who was asked, write the ask into the
 * chat as a passive `app.persona_ask` entry (no run starts) and create one Persona turn per Persona. Nothing here
 * waits for a model.
 */
export const askPersonas = (
  input: Ask,
  ids: readonly number[],
  order: 'parallel' | 'sequence',
  content: string | TextContent[],
) =>
  Effect.gen(function* () {
    const invocations = yield* Invocations
    const { personas } = yield* AgentInput
    const pi = yield* PiSessions
    const now = yield* epochSeconds
    const frozen = yield* freeze(ids)
    if (frozen.length > 8) return yield* new InvalidInput({ reason: 'persona_count' })
    const admission = {
      chat: input.thread,
      operationId: input.operationId,
      receipt: { kind: 'persona_ask', origin: 'owner' },
      flow: { flow: 'persona_ask', via: 'app', actor: 'owner', count: frozen.length, personaOrder: order },
    } as const
    return yield* (yield* ChatOperations).admit(admission, (admitted) =>
      Effect.gen(function* () {
        const asked = frozen.map((persona, index) => ({
          operationId: input.operationId,
          persona: persona.id,
          revision: persona.revision,
          chat: input.thread,
          order: index,
        }))
        yield* invocations.insert(asked, now)
        const write = { requestId: input.operationId, entry: askEntry(frozen, order, content, now) }
        const harness = yield* Effect.andThen(pi.write(admitted.session, write), pi.pi).pipe(
          Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
        )
        const parent = conversationId(admitted.session)
        yield* attempt(() =>
          personas.start(harness, {
            operationId: input.operationId,
            chat: input.thread,
            parent,
            personas: frozen,
            order,
          }),
        )
        return { session: admitted.session, operationId: input.operationId, accepted: true }
      }),
    )
  })

/**
 * The owner's reply to a Persona's hold (ADR 0041): its decision on a held call, or that they allowed the tool it asked
 * for. The Persona goes on in its fork at the revision it answered with, and writes its next answer, recorded as its
 * own invocation, into the chat it was asked in; that chat must still be open. Once per operation.
 */
export const resumePersona = Effect.fn('personas.resume')(function* (fork: string, operationId: string, text: string) {
  const chats = yield* Chats
  const found = Option.getOrUndefined(yield* chats.personaFork(fork))
  if (found === undefined) return yield* new NotFound({ what: 'persona fork' })
  yield* (yield* Conversations).requireActing(fork)
  const persona = yield* frozenAt(found.persona, found.revision)
  const invocations = yield* Invocations
  const asked = { operationId, persona: persona.id, revision: persona.revision, chat: found.parent, order: 0 }
  yield* invocations.insert([asked], yield* epochSeconds)
  yield* invocations.running(operationId, persona.id)
  const parent = conversationId(yield* chats.session(found.parent))
  const forked = conversationId(yield* chats.session(fork))
  const harness = yield* (yield* PiSessions).pi.pipe(
    Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
  )
  const { personas } = yield* AgentInput
  yield* attempt(() =>
    personas.resume(harness, { operationId, chat: found.parent, parent, fork: forked, persona, text }),
  )
})
