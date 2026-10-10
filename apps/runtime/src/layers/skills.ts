import type { ConversationId } from '@earendil-works/pi-durable'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { nowMillis } from '../clock.ts'
import { toAppError } from '../http/errors.ts'
import { GrantStore } from '../mcp/grants.ts'
import { McpHostInstance } from '../mcp/host.ts'
import type { SkillRequestOptions } from '../mcp/types.ts'
import { CheapModels } from '../memory/model.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { SkillLearner } from '../skills/learner.ts'
import { SkillLibrary } from '../skills/library.ts'
import { Learner, Skills } from '../skills/service.ts'
import { SqliteDraftLog, SqliteSkillState } from '../skills/store.ts'

/** A call into a shared instance's async code: a failure is the `AppError` it threw, anything else `Internal`. */
const fromPromise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toAppError })
/** The same for its synchronous code. */
const fromSync = <A>(run: () => A) => Effect.try({ try: run, catch: toAppError })

/** Skills from the owner's MCP libraries, through `library` (its listing cache is the one the agent keeps). */
export const skillsOver = (library: SkillLibrary): Skills['Service'] =>
  Skills.of({
    sources: Effect.fn('Skills.sources')(function* () {
      return yield* Effect.sync(() => library.sources())
    }),
    enabled: Effect.fn('Skills.enabled')(function* (serverId: string) {
      return yield* Effect.sync(() => library.enabled(serverId))
    }),
    setEnabled: Effect.fn('Skills.setEnabled')(function* (serverId: string, enabled: boolean) {
      yield* fromSync(() => library.setEnabled(serverId, enabled))
    }),
    invalidate: Effect.fn('Skills.invalidate')(function* (serverId: string, unavailable?: boolean) {
      yield* Effect.sync(() => library.invalidate(serverId, unavailable))
    }),
    catalog: Effect.fn('Skills.catalog')(function* (
      options?: SkillRequestOptions,
      include?: (serverId: string) => boolean,
    ) {
      return yield* fromPromise(() => library.catalog(options, include))
    }),
    activate: Effect.fn('Skills.activate')(function* (session: string, handle: string, options?: SkillRequestOptions) {
      return yield* fromPromise(() => library.activate(session, handle, options))
    }),
    activateSelection: Effect.fn('Skills.activateSelection')(function* (
      session: string,
      serverId: string,
      uri: string,
      options: SkillRequestOptions,
    ) {
      return yield* fromPromise(() => library.activateSelection(session, serverId, uri, options))
    }),
    read: Effect.fn('Skills.read')(function* (
      session: string,
      handle: string,
      path: string,
      options?: SkillRequestOptions,
    ) {
      return yield* fromPromise(() => library.read(session, handle, path, options))
    }),
  })

/** The skill learner, through `learner` (its busy set keeps one consideration per conversation). */
export const learnerOver = (learner: SkillLearner): Learner['Service'] =>
  Learner.of({
    consider: Effect.fn('Learner.consider')(function* (conversation: ConversationId, signal?: AbortSignal) {
      return yield* fromPromise(() => learner.consider(conversation, signal))
    }),
  })

/**
 * Start step 15: skills from the owner's MCP libraries over the host's connections, and the learner that proposes new
 * ones, each made once.
 */
export const SkillsLive: Layer.Layer<Skills | Learner, never, AgentInput | Db | McpHostInstance | CheapModels> =
  Layer.effectContext(
    Effect.gen(function* () {
      const { harness } = yield* AgentInput
      const db = yield* Db
      const { manager } = yield* McpHostInstance
      const cheap = yield* CheapModels
      const state = new SqliteSkillState(db)
      const grants = new GrantStore(db)
      const library = new SkillLibrary(manager, state, nowMillis)
      const learner = new SkillLearner({
        drafts: new SqliteDraftLog(db),
        harness,
        manager,
        library,
        state,
        model: cheap('skill'),
        allows: (serverId, name) => grants.allows({ serverId, capability: 'tool', name }),
        now: nowMillis,
      })
      return Context.merge(Skills.context(skillsOver(library)), Learner.context(learnerOver(learner)))
    }),
  )
