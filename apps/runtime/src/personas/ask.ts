import type { TextContent } from '@earendil-works/pi-ai'
import type { PersonaAskData } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { epochSeconds } from '../clock.ts'
import { ChatOperations } from '../chats/service.ts'
import { InvalidInput, attempt, toAppError } from '../http/errors.ts'
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
