import type { TextContent } from '@earendil-works/pi-ai'
import type { PersonaAskData } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import { InvalidInput } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import type { FrozenPersona, PersonaTurnKit } from '../pi/persona-turn.ts'
import type { PersonaRegistry } from './registry.ts'
import { Chats, Conversations, Invocations, Personas, attempt, attemptSync, nowSecondsEffect } from '../services.ts'

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
const freeze = (registry: PersonaRegistry, ids: readonly number[]): readonly FrozenPersona[] => {
  const active = registry.active()
  return [...new Set(ids)].map((id) => {
    const persona = active.find((each) => each.id === id)
    if (persona === undefined) throw new InvalidInput({ reason: `composer:persona:${String(id)}` })
    const { name, revision, avatar, role, instructions, exclusions, model } = persona
    return {
      id,
      name,
      revision,
      avatar,
      role,
      instructions,
      ...(registry.offers(model) && model !== undefined ? { model } : {}),
      exclusions,
    }
  })
}

type Ask = {
  readonly harness: PiHarness
  readonly personas: PersonaTurnKit
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
 * The owner tagged Personas: each answers once, attributed, in this chat, and Goblin does not (ADR 0033). Under the
 * chat's admission lock, once per operation: admit it, record who was asked, write the ask into the chat as a passive
 * `app.persona_ask` entry (no run starts) and create one Persona turn per Persona. Nothing here waits for a model.
 */
export const askPersonas = (
  input: Ask,
  ids: readonly number[],
  order: 'parallel' | 'sequence',
  content: string | TextContent[],
) =>
  Effect.gen(function* () {
    const invocations = yield* Invocations
    const conversations = yield* Conversations
    const chats = yield* Chats
    const now = yield* nowSecondsEffect
    const frozen = yield* Personas.use((registry) => attemptSync(() => freeze(registry, ids)))
    if (frozen.length > 8) return yield* new InvalidInput({ reason: 'persona_count' })
    return yield* attempt(() =>
      chats.withChat(input.thread, async () => {
        conversations.requireOpen(input.thread)
        const admitted = chats.admit(input.thread, input.operationId, now)
        const asked = frozen.map((persona, index) => ({
          operationId: input.operationId,
          persona: persona.id,
          revision: persona.revision,
          chat: input.thread,
          order: index,
        }))
        invocations.insert(asked, now)
        const pi = await input.harness.pi()
        const parent = conversationId(admitted.session)
        const chat = await pi.conversation(parent, BACKGROUND)
        if (chat === undefined) throw new InvalidInput({ reason: 'chat' })
        await chat.submit(
          { type: 'write', requestId: input.operationId, entry: askEntry(frozen, order, content, now) },
          BACKGROUND,
        )
        await input.personas.start(pi, {
          operationId: input.operationId,
          chat: input.thread,
          parent,
          personas: frozen,
          order,
        })
        return { session: admitted.session, operationId: input.operationId, accepted: true }
      }),
    )
  })
