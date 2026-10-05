import type { MemberController } from './controller.ts'
import type { MemberJournal } from './journal.ts'
import type { McpHost } from '../mcp/host.ts'
import { hash } from './interactions.ts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import { mcpModelResult } from '../mcp/extension.ts'

function decisionText(kind: string | null, text: string): void {
  if (kind === 'approval' && text !== 'deny' && text !== 'allow_once')
    throw new Conflict({ reason: 'approval decision' })
  if (kind === 'access' && text !== 'deny' && text !== 'acknowledge') throw new Conflict({ reason: 'access decision' })
}

/** Decisions are consumed before dispatch; a lost dispatch receipt is unknown and is never automatically resent. */
export async function answerMember(
  members: MemberController,
  host: McpHost,
  journal: MemberJournal,
  input: { actor: string; id: string; operationId: string; expectedHash: string; text: string },
): Promise<boolean> {
  const { actor, id, operationId, expectedHash, text } = input
  const row = members.interactions.require(id)
  if (row.answererUserId !== actor) throw new Forbidden({ reason: 'interaction answerer' })
  const principal = await members.access.require(row.sessionId, row.approvalKind !== 'access')
  if (principal === undefined || principal.memberVersion !== row.memberVersion)
    throw new NotFound({ what: 'interaction epoch' })
  const decisionHash = await hash(text)
  decisionText(row.approvalKind, text)
  const tool =
    row.approvalKind === 'approval' && text === 'allow_once' ? await members.interactions.tool(row) : undefined
  // Replays must be recognizable even if a grant or budget changed after the consumed decision.
  if (row.state === 'pending' && tool !== undefined) await members.authorizeTool(row.sessionId, tool)
  if (row.state === 'pending' && row.approvalKind === 'question') await members.require(row.sessionId)
  const decision = members.interactions.consume(id, actor, operationId, expectedHash, decisionHash)
  if (decision.replay) {
    await journal.ready()
    return true
  }
  let result: unknown
  if (tool !== undefined)
    result = mcpModelResult(
      tool.serverId,
      await host.manager.callTool(tool.serverId, tool.name, tool.arguments, {
        caller: 'model',
        authorize: () => members.authorizeTool(row.sessionId, tool),
      }),
    )
  // This outbox writes only into the requester's context: private results never enter root history.
  journal.capture({
    key: `interaction:${id}:${operationId}:receipt`,
    session: row.sessionId,
    user: principal.userId,
    kind: 'decision',
    body: JSON.stringify({
      interactionId: id,
      actor,
      requesterUserId: principal.userId,
      decision: text,
      ...(result === undefined ? {} : { result }),
    }),
    at: Date.now(),
  })
  await journal.ready()
  if (row.approvalKind === 'question')
    await members.submit(principal, row.sessionId, text, `interaction:${id}:${operationId}`)
  return true
}
