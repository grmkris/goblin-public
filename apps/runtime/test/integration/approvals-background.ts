import { expect } from 'vitest'
import { Schema } from 'effect'
import { ApprovalView, ConversationView, RoutineRunView, RoutineView } from '@goblin/contracts'
import { call, waitFor, workspaceUntil, type Person } from './owner-requests.ts'
import { approvalId } from './approvals-case.ts'

/** The subagent the background run starts to hold a call. */
const approver = (view: ConversationView) => view.kind === 'subagent' && view.title === 'approver'

const toolInput = (operationKey: string) =>
  `call mcp_call ${JSON.stringify({ serverId: 'apps-fixture', name: 'board', arguments: { operationKey } })}`
async function heldIn(base: string, owner: Person, session: string): Promise<string> {
  const snapshot = await waitFor(base, owner, `/api/conversations/${session}/snapshot`, 'approval-required')
  const id = approvalId(JSON.parse(snapshot))
  if (id === undefined) throw new Error('no background approval')
  return `/api/mcp/approvals/${encodeURIComponent(id)}`
}
const RunPage = Schema.Struct({ runs: Schema.Array(RoutineRunView) })

export async function approvalsBackground(base: string, owner: Person) {
  const draft = Schema.decodeUnknownSync(RoutineView)(
    await (
      await call(base, owner, '/api/routines', {
        operationId: crypto.randomUUID(),
        definition: {
          title: 'Approval fixture',
          prompt: toolInput('routine-frozen'),
          timezone: 'UTC',
          trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
          notifyTelegram: false,
          allowedTools: [{ serverId: 'apps-fixture', name: 'board' }],
          budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
        },
      })
    ).json(),
  )
  expect(
    (
      await call(base, owner, `/api/routines/${draft.id}/confirm`, {
        revision: draft.revision,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200)
  const run = Schema.decodeUnknownSync(RoutineRunView)(
    await (
      await call(base, owner, `/api/routines/${draft.id}/run`, {
        revision: draft.revision,
        operationId: crypto.randomUUID(),
        confirmRun: true,
      })
    ).json(),
  )
  let session = run.sessionId
  for (let attempt = 0; session === null && attempt < 100; attempt++) {
    const page = Schema.decodeUnknownSync(RunPage)(
      await (await call(base, owner, `/api/routines/${draft.id}/runs`)).json(),
    )
    session = page.runs.find((item) => item.id === run.id)?.sessionId ?? null
    if (session === null) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (session === null) throw new Error('no routine conversation')
  const path = await heldIn(base, owner, session)
  const waiting = Schema.decodeUnknownSync(RunPage)(
    await (await call(base, owner, `/api/routines/${draft.id}/runs`)).json(),
  )
  expect(waiting.runs[0]?.state).toBe('waiting_owner')
  const approved = await call(base, owner, path, { allowed: true })
  expect(approved.status).toBe(200)
  expect(Schema.decodeUnknownSync(ApprovalView)(await approved.json()).state).toBe('completed')
  await waitFor(base, owner, `/api/routines/${draft.id}/runs`, '"state":"completed"')

  const parent = Schema.decodeUnknownSync(ConversationView)(
    await (await call(base, owner, '/api/conversations', {})).json(),
  )
  expect(
    (
      await call(base, owner, `/api/conversations/${parent.id}/messages`, {
        input: `call subagent_spawn ${JSON.stringify({ name: 'approver', message: toolInput('subagent-frozen') })}`,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202)
  const child = (
    await workspaceUntil(base, owner, ({ conversations }) => conversations.some(approver))
  ).conversations.find(approver)
  if (child === undefined) throw new Error('no subagent conversation')
  const childPath = await heldIn(base, owner, child.id)
  expect((await call(base, owner, childPath, { allowed: false })).status).toBe(200)
  expect(Schema.decodeUnknownSync(ApprovalView)(await (await call(base, owner, childPath)).json()).state).toBe(
    'refused',
  )
}
