import type { PiHarness } from 'agents/harness/pi'
import type { MemberController } from './controller.ts'
import type { MemberPrincipal, MemberRequest } from '../env.ts'
import type { ConversationRegistry } from '../conversations.ts'
import { Forbidden, InvalidInput } from '../http/errors.ts'
type Input = {
  harness: PiHarness
  members: MemberController
  principal: MemberPrincipal
  request: MemberRequest
  registry: ConversationRegistry
}
export async function memberDispatch(input: Input): Promise<unknown> {
  const { members, principal, request, registry } = input
  switch (request.action) {
    case 'list':
      return members.list(principal)
    case 'usage':
      return members.usage(principal)
    case 'interactions':
      return members.listInteractions(principal)
    case 'request-access':
      return members.requestAccess(principal, request.operationId, request.message)
    case 'submit':
      return members.submit(principal, request.session, request.input, request.operationId, request.appContext)
    case 'answer':
      if (principal.role === 'viewer') throw new Forbidden({ reason: 'viewer answer' })
      return members.answer(principal.userId, request.id, request.operationId, request.requestHash, request.input)
    case 'create':
      await members.access.verify(principal, true)
      return registry.view(await members.create(principal, 'private', request.from))
    case 'capabilities':
    case 'history':
    case 'readers':
    case 'snapshot':
    case 'stop':
    case 'update':
      return memberConversationDispatch(input)
  }
}
async function memberConversationDispatch({ members, principal, request, registry, harness }: Input): Promise<unknown> {
  if (!('session' in request)) throw new InvalidInput({ reason: 'member operation' })
  const session = await members.session(principal, request.session)
  switch (request.action) {
    case 'readers':
      return members.readers(principal, request.session, request.readers)
    case 'stop':
      await members.access.verify(principal, true)
      members.writable(principal, session)
      await harness.abort({ session })
      await registry.stopSubagents(session)
      return { stopped: true }
    case 'update':
      await members.access.verify(principal, true)
      members.writable(principal, session)
      return (await registry.update(session, request.change, Math.floor(Date.now() / 1000))).view
    case 'history': {
      const value = await registry.history(session, request.before)
      await members.access.verify(principal)
      await members.session(principal, request.session)
      return value
    }
    case 'snapshot': {
      const events = await harness.session(session).events()
      const value = events.snapshot
      await events.stop()
      await members.access.verify(principal)
      await members.session(principal, request.session)
      return value
    }
    case 'capabilities':
    case 'submit':
      throw new InvalidInput({ reason: 'member operation' })
  }
}
