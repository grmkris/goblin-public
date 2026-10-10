import type {
  CreatePersona,
  PersonaDetail,
  PersonaInvocationView,
  PersonaRevisionView,
  PersonaView,
  UpdatePersona,
} from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { type AppError, attemptSync } from '../http/errors.ts'
import { nowSeconds } from '../organize/effects.ts'
import { Changes } from '../runtime/changes.ts'
import type { NewInvocation, PersonaInvocations } from './invocations.ts'
import type { PersonaActor, PersonaRegistry } from './registry.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** Personas a write made or changed, by id (ADR 0033). */
    'personas.changed': { readonly ids: readonly number[] }
  }
}

/** What `create` answers: the Persona, and whether this call made it rather than finding it by its operation id. */
type MadePersona = { readonly persona: PersonaView; readonly created: boolean }

/** A Persona just before and just after one change, read in the step that made it. */
export type PersonaChange = { readonly before: PersonaView; readonly after: PersonaView }

/**
 * The owner's Personas (ADR 0033): named, versioned agent definitions. Every change is a new revision of the one it
 * names (`expectedRevision`), a model must be one the deployment offers, and archiving keeps the history and frees the
 * name. Times are read inside, in epoch seconds.
 */
export class Personas extends Context.Service<
  Personas,
  {
    /** Every Persona, archived ones included, in creation order. */
    readonly list: Effect.Effect<readonly PersonaView[]>
    /** The Personas that can answer now. */
    readonly active: Effect.Effect<readonly PersonaView[]>
    /** One Persona; `NotFound` when there is none with `id`. */
    readonly get: (id: number) => Effect.Effect<PersonaView, AppError>
    /** The active Persona named `name`, ignoring case. */
    readonly byName: (name: string) => Effect.Effect<Option.Option<PersonaView>>
    /** A Persona with its revisions, newest first. */
    readonly detail: (id: number) => Effect.Effect<PersonaDetail, AppError>
    /** One stored revision, as an invocation froze it. */
    readonly revision: (id: number, revision: number) => Effect.Effect<PersonaRevisionView, AppError>
    /** Whether this deployment offers `model` now. */
    readonly offers: (model: string | undefined) => Effect.Effect<boolean>
    /** A new Persona at revision 1, or the one `input.operationId` already made. A taken name is a `Conflict`. */
    readonly create: (input: CreatePersona, actor: PersonaActor) => Effect.Effect<MadePersona, AppError>
    /**
     * A new revision with `change` applied, if `change.expectedRevision` is the current one (else `Conflict`), answered
     * before and after; nothing changed is no revision.
     */
    readonly update: (id: number, change: UpdatePersona, actor: PersonaActor) => Effect.Effect<PersonaChange, AppError>
  }
>()('goblin/personas/Personas') {
  /** The Personas over `store`, the one per agent: each new Persona and real change tells `personas.changed`. */
  static readonly make = (store: PersonaRegistry) =>
    Effect.gen(function* () {
      const changes = yield* Changes
      const changed = (id: number) => changes.publish('personas.changed', { ids: [id] })
      return Personas.of({
        list: Effect.sync(() => store.list()).pipe(Effect.withSpan('Personas.list')),
        active: Effect.sync(() => store.active()).pipe(Effect.withSpan('Personas.active')),
        get: Effect.fn('Personas.get')(function* (id: number) {
          return yield* attemptSync(() => store.get(id))
        }),
        byName: Effect.fn('Personas.byName')(function* (name: string) {
          return yield* Effect.sync(() => Option.fromUndefinedOr(store.byName(name)))
        }),
        detail: Effect.fn('Personas.detail')(function* (id: number) {
          return yield* attemptSync(() => store.detail(id))
        }),
        revision: Effect.fn('Personas.revision')(function* (id: number, revision: number) {
          return yield* attemptSync(() => store.revision(id, revision))
        }),
        offers: Effect.fn('Personas.offers')(function* (model: string | undefined) {
          return yield* Effect.sync(() => store.offers(model))
        }),
        create: Effect.fn('Personas.create')(function* (input: CreatePersona, actor: PersonaActor) {
          const now = yield* nowSeconds
          const made = yield* attemptSync(() => store.create(input, actor, now))
          if (made.created) yield* changed(made.persona.id)
          return made
        }),
        update: Effect.fn('Personas.update')(function* (id: number, change: UpdatePersona, actor: PersonaActor) {
          const now = yield* nowSeconds
          const result = yield* attemptSync(() => {
            const before = store.get(id)
            return { before, after: store.update(id, change, actor, now) }
          })
          if (result.after.revision !== result.before.revision) yield* changed(id)
          return result
        }),
      })
    })
}

/**
 * Which Persona answers which owner message, and how far it got (ADR 0033). A settled invocation never moves again, so
 * a replayed step or a Stop after the answer changes nothing.
 */
export class Invocations extends Context.Service<
  Invocations,
  {
    /** Records the tagged Personas of one send, once per operation and Persona; answers the rows it wrote. */
    readonly insert: (
      invocations: readonly NewInvocation[],
      now: number,
    ) => Effect.Effect<readonly PersonaInvocationView[]>
    readonly get: (operationId: string, persona: number) => Effect.Effect<Option.Option<PersonaInvocationView>>
    /** The invocations not settled yet, oldest first. */
    readonly live: Effect.Effect<readonly PersonaInvocationView[]>
    /** Every invocation of one send, in order. */
    readonly of: (operationId: string) => Effect.Effect<readonly PersonaInvocationView[]>
    /** The Persona started working; only a pending invocation moves. */
    readonly running: (operationId: string, persona: number) => Effect.Effect<void>
    /** Settles one invocation; a settled one stays as it is. Whether this call settled it. */
    readonly settle: (
      operationId: string,
      persona: number,
      state: 'answered' | 'failed' | 'stopped',
      now: number,
      answerEntry?: number,
    ) => Effect.Effect<boolean>
    /** Stops every unsettled invocation in `chat` (the owner's Stop); answers how many it stopped. */
    readonly stopChat: (chat: string, now: number) => Effect.Effect<number>
  }
>()('goblin/personas/Invocations') {
  /**
   * The invocations over `store`, the one per agent. Its own listeners still tell the workspace feed what changed:
   * the Persona asks and Stop write through the same instance.
   */
  static readonly make = (store: PersonaInvocations) =>
    Invocations.of({
      insert: Effect.fn('Invocations.insert')(function* (asked: readonly NewInvocation[], now: number) {
        return yield* Effect.sync(() => store.insert(asked, now))
      }),
      get: Effect.fn('Invocations.get')(function* (operationId: string, persona: number) {
        return yield* Effect.sync(() => Option.fromUndefinedOr(store.get(operationId, persona)))
      }),
      live: Effect.sync(() => store.live()).pipe(Effect.withSpan('Invocations.live')),
      of: Effect.fn('Invocations.of')(function* (operationId: string) {
        return yield* Effect.sync(() => store.of(operationId))
      }),
      running: Effect.fn('Invocations.running')(function* (operationId: string, persona: number) {
        yield* Effect.sync(() => store.running(operationId, persona))
      }),
      settle: Effect.fn('Invocations.settle')(function* (
        operationId: string,
        persona: number,
        state: 'answered' | 'failed' | 'stopped',
        now: number,
        answerEntry?: number,
      ) {
        return yield* Effect.sync(() => store.settle(operationId, persona, state, now, answerEntry))
      }),
      stopChat: Effect.fn('Invocations.stopChat')(function* (chat: string, now: number) {
        return yield* Effect.sync(() => store.stopChat(chat, now))
      }),
    })
}
