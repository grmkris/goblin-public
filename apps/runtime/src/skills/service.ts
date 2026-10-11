import type { ConversationId } from '@earendil-works/pi-durable'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { SkillRequestOptions } from '../mcp/types.ts'
import type { LearnOutcome } from './learner.ts'
import type { Activated, Catalog, SkillFile } from './library.ts'

/**
 * Skills from the owner's MCP skills libraries, as the agent's programs use them: which servers the owner takes skills
 * from, their catalog, and a conversation's activations and verified file reads. `options.authorize` is checked again
 * before every dispatch to a server.
 */
export class Skills extends Context.Service<
  Skills,
  {
    /** The servers the owner uses skills from and still has configured. */
    readonly sources: () => Effect.Effect<readonly string[]>
    readonly enabled: (connectionId: string) => Effect.Effect<boolean>
    /** Turns skills from a server on or off; `NotFound` for a server the agent does not have. */
    readonly setEnabled: (connectionId: string, enabled: boolean) => Effect.Effect<void, AppError>
    /** Forgets a server's listing, durably, after it said its skills changed (or that it stopped serving them). */
    readonly invalidate: (connectionId: string, unavailable?: boolean) => Effect.Effect<void>
    /** Every listed skill of the enabled servers `include` keeps; a server that cannot be read is named unavailable. */
    readonly catalog: (
      options?: SkillRequestOptions,
      include?: (connectionId: string) => boolean,
    ) => Effect.Effect<Catalog, AppError>
    /** Loads a skill by its handle into the conversation of `session`: its verified `SKILL.md` and its files. */
    readonly activate: (
      session: string,
      handle: string,
      options?: SkillRequestOptions,
    ) => Effect.Effect<Activated, AppError>
    /** Loads the skill the owner selected by its server and URI, whatever its handle is now. */
    readonly activateSelection: (
      session: string,
      connectionId: string,
      uri: string,
      options: SkillRequestOptions,
    ) => Effect.Effect<Activated, AppError>
    /** A file of a skill the conversation activated, verified against the manifest it was loaded with. */
    readonly read: (
      session: string,
      handle: string,
      path: string,
      options?: SkillRequestOptions,
    ) => Effect.Effect<SkillFile, AppError>
  }
>()('goblin/skills/Skills') {}

/**
 * The skill learner: after a final answer, whether the exchange teaches a procedure worth proposing as a draft to the
 * owner's skills library. Its outcome is all it says; a failure is the `failed` outcome.
 */
export class Learner extends Context.Service<
  Learner,
  { readonly consider: (conversation: ConversationId, signal?: AbortSignal) => Effect.Effect<LearnOutcome, AppError> }
>()('goblin/skills/Learner') {}
