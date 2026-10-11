import { expect } from 'vitest'
import type { ConversationView } from '@goblin/contracts'
import { callOwner } from '../owner-client.ts'
import { signedIn, workspaceUntil, type Person } from './owner-requests.ts'
import { decide, heldIn } from './approvals-case.ts'
import { waitFor } from './until.ts'

/** The subagent the background run starts to hold a call. */
const approver = (view: ConversationView) => view.kind === 'subagent' && view.title === 'approver'

const toolInput = (operationKey: string) =>
  `call mcp_call ${JSON.stringify({ connectionId: 'apps-fixture', name: 'board', arguments: { operationKey } })}`

/** A routine run and a subagent each hold an ask-first call: the owner approves the routine's and refuses the other. */
export async function approvalsBackground(base: string, owner: Person) {
  const me = signedIn(base, owner)
  const draft = await callOwner(me, (api) =>
    api.routines.propose({
      payload: {
        operationId: crypto.randomUUID(),
        definition: {
          title: 'Approval fixture',
          prompt: toolInput('routine-frozen'),
          timezone: 'UTC',
          trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
          notifyTelegram: false,
          allowedTools: [{ connectionId: 'apps-fixture', name: 'board' }],
          budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
        },
      },
    }),
  )
  const params = { id: draft.id }
  const revision = { revision: draft.revision, operationId: crypto.randomUUID() }
  await callOwner(me, (api) => api.routines.confirm({ params, payload: revision }))
  const run = await callOwner(me, (api) =>
    api.routines.run({
      params,
      payload: { revision: draft.revision, operationId: crypto.randomUUID(), confirmRun: true },
    }),
  )
  const runs = async () => (await callOwner(me, (api) => api.routines.runs({ params }))).runs
  const session = await waitFor(
    async () => run.sessionId ?? (await runs()).find((item) => item.id === run.id)?.sessionId ?? null,
    (found) => found !== null,
    'the routine conversation',
  )
  if (session === null) throw new Error('no routine conversation')
  const held = await heldIn(me, session)
  expect((await runs())[0]?.state).toBe('waiting_owner')
  expect((await decide(me, held, true)).state).toBe('completed')
  await waitFor(runs, (all) => all.some((item) => item.state === 'completed'), 'the routine run completed')

  const parent = await callOwner(me, (api) => api.conversations.create({ payload: {} }))
  const input = `call subagent_spawn ${JSON.stringify({ name: 'approver', message: toolInput('subagent-frozen') })}`
  const sent = await callOwner(me, (api) =>
    api.conversations.submit({ params: { id: parent.id }, payload: { input, operationId: crypto.randomUUID() } }),
  )
  expect(sent.accepted).toBe(true)
  const child = (
    await workspaceUntil(base, owner, ({ conversations }) => conversations.some(approver))
  ).conversations.find(approver)
  if (child === undefined) throw new Error('no subagent conversation')
  const childHeld = await heldIn(me, child.id)
  await decide(me, childHeld, false)
  expect((await callOwner(me, (api) => api.mcp.approval({ params: { id: childHeld } }))).state).toBe('refused')
}
