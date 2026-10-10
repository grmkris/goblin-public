import type { CapabilityTarget, HelperExclusion } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  CapabilityProfiles,
  type PiTools,
  ProfilesInstance,
  type Retooling,
  appAllowed,
  capabilityScope,
  configureHelper,
  copyExclusions,
  inheritedExclusions,
  narrowExclusions,
  ownExclusions,
  piToolsFor,
  resetSwitches,
  retoolOnce,
  setExclusion,
  syncPi,
} from '../capabilities/profiles.ts'
import { Capabilities } from '../capabilities/service.ts'
import { epochSeconds } from '../clock.ts'
import { attempt } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

// Each conversation's switches, as functions of the agent's database (capabilities/profiles.ts). Two layers are steps
// of the agent's start, in its order (layers/index.ts): the switches object a Topic's ports change (step 6) and the
// one retool (8). `CapabilitiesLive` serves the switches after the start.

/** Sets a conversation's Pi tool filter (where subagents are switched off), leaving its extensions as they are. */
const retool = (harness: PiHarness) => async (session: string, tools: PiTools) => {
  const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  await conversation?.configure({ tools }, BACKGROUND)
}

/** How the switches reach Pi: the agent's database, its subagent tools and its harness. */
const retooling: Effect.Effect<Retooling, never, AgentInput | Db> = Effect.gen(function* () {
  const { subagentTools, harness } = yield* AgentInput
  return { db: yield* Db, subagentTools, retool: retool(harness) }
})

/** Start step 6: the switches as one object, for a Topic's ports. */
export const ProfilesLive: Layer.Layer<ProfilesInstance, never, AgentInput | Db> = Layer.effect(
  ProfilesInstance,
  Effect.map(retooling, ({ db, subagentTools, retool: apply }) => new CapabilityProfiles(db, subagentTools, apply)),
)

/** Start step 8: the current complete delegation tool set is applied to the retained Pi filters, once. */
export const RetoolLive: Layer.Layer<never, never, AgentInput | Db> = Layer.effectDiscard(
  Effect.gen(function* () {
    const pi = yield* retooling
    const now = yield* epochSeconds
    yield* Effect.promise(() => retoolOnce(pi, 'retool:subagent-config', now))
  }),
)

/** Each conversation's switches over the agent's database, applied to Pi through its harness. */
export const CapabilitiesLive: Layer.Layer<Capabilities, never, AgentInput | Db> = Layer.effect(
  Capabilities,
  Effect.gen(function* () {
    const pi = yield* retooling
    const { db } = pi
    return Capabilities.of({
      scope: Effect.fn('Capabilities.scope')(function* (session: string) {
        return yield* Effect.sync(() => capabilityScope(db, session))
      }),
      app: Effect.fn('Capabilities.app')(function* (session: string, app: string) {
        return yield* Effect.sync(() => appAllowed(db, session, app))
      }),
      own: Effect.fn('Capabilities.own')(function* (session: string) {
        return yield* Effect.sync(() => ownExclusions(db, session))
      }),
      inherited: Effect.fn('Capabilities.inherited')(function* (thread: string) {
        return yield* Effect.sync(() => inheritedExclusions(db, thread))
      }),
      set: Effect.fn('Capabilities.set')(function* (session: string, target: CapabilityTarget, on: boolean) {
        const now = yield* epochSeconds
        yield* Effect.sync(() => setExclusion(db, session, target, on, now))
      }),
      narrow: Effect.fn('Capabilities.narrow')(function* (session: string, exclusions: readonly HelperExclusion[]) {
        const now = yield* epochSeconds
        yield* Effect.sync(() => narrowExclusions(db, session, exclusions, now))
      }),
      copy: Effect.fn('Capabilities.copy')(function* (from: string, to: string) {
        const now = yield* epochSeconds
        yield* Effect.sync(() => copyExclusions(db, from, to, now))
      }),
      reset: Effect.fn('Capabilities.reset')(function* (thread: string) {
        const now = yield* epochSeconds
        yield* attempt(() => resetSwitches(pi, thread, now))
      }),
      configureHelper: Effect.fn('Capabilities.configureHelper')(function* (
        parent: string,
        session: string,
        exclusions: readonly HelperExclusion[],
      ) {
        const now = yield* epochSeconds
        yield* attempt(() => configureHelper(pi, { parent, session, exclusions }, now))
      }),
      piTools: Effect.fn('Capabilities.piTools')(function* (session: string) {
        return yield* Effect.sync(() => piToolsFor(db, pi.subagentTools, session))
      }),
      syncPi: Effect.fn('Capabilities.syncPi')(function* (session: string) {
        yield* attempt(() => syncPi(pi, session))
      }),
    })
  }),
)
