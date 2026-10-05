import type { PiHarness } from 'agents/harness/pi'
import type { MemberController } from './controller.ts'
import type { MemberPrincipal } from '../env.ts'
import type { WorkspaceFeed } from '../workspace/feed.ts'
import { memberWorkspaceResponse } from './feed.ts'
import { memberEventResponse } from './streams.ts'
import { NotFound } from '../http/errors.ts'

/** Internal fetch receives only the Worker's verified principal, and checks D1 before opening or sending. */
export async function memberStreamRequest(
  request: Request,
  harness: PiHarness,
  members: MemberController,
  feed: WorkspaceFeed,
): Promise<Response> {
  const path = new URL(request.url).pathname
  // SAFETY: authenticated Worker constructs this internal principal; D1 is checked before use.
  const principal = JSON.parse(request.headers.get('x-purrable-principal') ?? 'null') as MemberPrincipal
  if (path === '/members/workspace/events') {
    await members.access.verify(principal)
    return memberWorkspaceResponse(feed, members, principal)
  }
  const id = /^\/members\/(\d{1,12})\/events$/u.exec(new URL(request.url).pathname)?.[1]
  if (id === undefined) throw new NotFound({ what: 'member stream' })
  const session = await members.session(principal, id)
  const verify = async () => {
    try {
      await members.access.verify(principal)
    } catch (error) {
      await members.invalidate(principal.memberId)
      throw error
    }
    await members.session(principal, id)
  }
  await verify()
  return memberEventResponse(await harness.session(session).events(), verify)
}
