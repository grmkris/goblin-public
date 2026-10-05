import type { MemberPrincipal, MemberRequest } from '../env.ts'
import * as Effect from 'effect/Effect'
import { Capabilities, Conversations, Members, attempt, requireResident } from '../services.ts'
import type { PiHarness } from 'agents/harness/pi'
import { capabilitiesOf } from '../capabilities/program.ts'
import { memberDispatch } from './dispatch.ts'
import { Entitlements } from '../billing/gates.ts'
import { requireRoutineSession } from '../routines/authority.ts'

export const executionAuthority = (session: string) =>
  Effect.gen(function* () {
    const principal = yield* Members.use((members) => attempt(() => members.require(session)))
    yield* requireResident
    if (principal === undefined) {
      yield* Entitlements.use((plans) => plans.require())
      yield* requireRoutineSession(session)
    }
  })
/** Member requests bypass owner renewal; capabilities come from the same intersection used for dispatch. */
export const memberProgram = (harness: PiHarness, principal: MemberPrincipal, request: MemberRequest) =>
  Effect.gen(function* () {
    const members = yield* Members
    const registry = yield* Conversations
    yield* attempt(() => members.access.verify(principal))
    if (request.action === 'capabilities') {
      const session = yield* attempt(() => members.session(principal, request.session))
      const view = yield* capabilitiesOf(session)
      yield* attempt(() => members.access.verify(principal))
      const scope = (yield* Capabilities).scope(session)
      return JSON.stringify({
        ...view,
        thread: request.session,
        servers: view.servers
          .filter((s) => scope.server(s.serverId))
          .map((s) => ({ ...s, tools: s.tools.filter((t) => scope.tool(s.serverId, t.name)) })),
        skills: view.skills.filter((s) => scope.skills(s.serverId)),
        subagents: scope.subagents(),
      })
    }
    return JSON.stringify(yield* attempt(() => memberDispatch({ harness, members, principal, request, registry })))
  })
