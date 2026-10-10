import type { CapabilityTarget, HelperExclusion } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { CapabilityProfiles, type PiTools, ProfilesInstance } from '../capabilities/profiles.ts'
import { Capabilities } from '../capabilities/service.ts'
import { ChatsInstance } from '../chats/directory.ts'
import { attempt } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

// Each conversation's switches. Two layers are steps of the agent's start, in its order (layers/index.ts): the
// capability profiles (step 6), made once and shared by `ProfilesInstance` with the conversations, Topics and the
// mover, and their one retool (8). `CapabilitiesLive` serves them after the start.

/** Wall-clock seconds, the unit profiles are kept in. */
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/** Sets a conversation's Pi tool filter (where subagents are switched off), leaving its extensions as they are. */
const retool = (harness: PiHarness) => async (session: string, tools: PiTools) => {
  const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  await conversation?.configure({ tools }, BACKGROUND)
}

/** Start step 6: each conversation's switches, the one profile store, over the chat directory. */
export const ProfilesLive: Layer.Layer<ProfilesInstance, never, AgentInput | Db | ChatsInstance> = Layer.effect(
  ProfilesInstance,
  Effect.gen(function* () {
    const input = yield* AgentInput
    return new CapabilityProfiles(yield* Db, input.subagentTools, retool(input.harness), yield* ChatsInstance)
  }),
)

/** Start step 8: the current complete delegation tool set is applied to the retained Pi filters, once. */
export const RetoolLive: Layer.Layer<never, never, ProfilesInstance> = Layer.effectDiscard(
  Effect.gen(function* () {
    const profiles = yield* ProfilesInstance
    const now = yield* nowSeconds
    yield* Effect.promise(() => profiles.retoolOnce('retool:subagent-config', now))
  }),
)

/** Each conversation's switches, over the one profile store the conversations, Topics and the mover share. */
export const CapabilitiesLive: Layer.Layer<Capabilities, never, ProfilesInstance> = Layer.effect(
  Capabilities,
  Effect.gen(function* () {
    const profiles = yield* ProfilesInstance
    return Capabilities.of({
      scope: Effect.fn('Capabilities.scope')(function* (session: string) {
        return yield* Effect.sync(() => profiles.scope(session))
      }),
      app: Effect.fn('Capabilities.app')(function* (session: string, app: string) {
        return yield* Effect.sync(() => profiles.app(session, app))
      }),
      own: Effect.fn('Capabilities.own')(function* (session: string) {
        return yield* Effect.sync(() => profiles.own(session))
      }),
      inherited: Effect.fn('Capabilities.inherited')(function* (thread: string) {
        return yield* Effect.sync(() => profiles.inherited(thread))
      }),
      set: Effect.fn('Capabilities.set')(function* (session: string, target: CapabilityTarget, on: boolean) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => profiles.set(session, target, on, now))
      }),
      narrow: Effect.fn('Capabilities.narrow')(function* (session: string, exclusions: readonly HelperExclusion[]) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => profiles.narrow(session, exclusions, now))
      }),
      copy: Effect.fn('Capabilities.copy')(function* (from: string, to: string) {
        const now = yield* nowSeconds
        yield* Effect.sync(() => profiles.copy(from, to, now))
      }),
      reset: Effect.fn('Capabilities.reset')(function* (thread: string) {
        const now = yield* nowSeconds
        yield* attempt(() => profiles.reset(thread, now))
      }),
      configureHelper: Effect.fn('Capabilities.configureHelper')(function* (
        parent: string,
        session: string,
        exclusions: readonly HelperExclusion[],
      ) {
        const now = yield* nowSeconds
        yield* attempt(() => profiles.configureHelper(parent, session, exclusions, now))
      }),
      piTools: Effect.fn('Capabilities.piTools')(function* (session: string) {
        return yield* Effect.sync(() => profiles.piTools(session))
      }),
      syncPi: Effect.fn('Capabilities.syncPi')(function* (session: string) {
        yield* attempt(() => profiles.syncPi(session))
      }),
    })
  }),
)
