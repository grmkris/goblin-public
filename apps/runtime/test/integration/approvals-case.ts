import { approvalsBackground } from './approvals-background.ts'
import { expect } from 'vitest'
import { Predicate, Schema } from 'effect'
import { ApprovalView } from '@goblin/contracts'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { call, grantPlan, lever, person, showing, signedIn, type Person } from './owner-requests.ts'
import { answerOf } from './probe-reads.ts'

const SERVER = 'apps-fixture'
const TOOL = 'board'
const args = {
  operationKey: 'op-owner-reviewed',
  rewardToken: '0x123',
  nested: { amount: 5 },
  accessToken: 'fixture-private',
}
const decodeCalls = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.Unknown })))
const decodeApproval = Schema.decodeUnknownSync(ApprovalView)
export function approvalId(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(approvalId).find((id) => id !== undefined)
  if (!Predicate.isObject(value)) return undefined
  if (
    'kind' in value &&
    value.kind === 'approval-required' &&
    'approvalId' in value &&
    typeof value.approvalId === 'string'
  )
    return value.approvalId
  return Object.values(value)
    .map(approvalId)
    .find((id) => id !== undefined)
}

/** The id of the call held for approval in `chat`, once its snapshot shows it. */
export async function heldIn(me: AgentFetch, chat: string): Promise<string> {
  const id = approvalId(JSON.parse(await showing(me, chat, 'approval-required')))
  if (id === undefined) throw new Error('missing held call')
  return id
}

/** The owner's decision on the held call `id`. */
export const decide = (me: AgentFetch, id: string, allowed: boolean) =>
  callOwner(me, (api) => api.mcp.decideApproval({ params: { id }, payload: { allowed } }))

async function hold(me: AgentFetch, inputArgs: unknown = args) {
  const thread = await callOwner(me, (api) => api.conversations.create({ payload: {} }))
  const input = `call mcp_call ${JSON.stringify({ serverId: SERVER, name: TOOL, arguments: inputArgs })}`
  const sent = await callOwner(me, (api) =>
    api.conversations.submit({ params: { id: thread.id }, payload: { input, operationId: crypto.randomUUID() } }),
  )
  expect(sent.accepted).toBe(true)
  const id = await heldIn(me, thread.id)
  return { id, thread: thread.id, path: `/api/mcp/approvals/${encodeURIComponent(id)}` }
}
const calls = async (base: string, owner: Person) =>
  decodeCalls(await (await lever(base, owner, 'approvals/calls')).json())
const mark = (me: AgentFetch, enabled: boolean) =>
  callOwner(me, (api) => api.mcp.setAskFirst({ payload: { serverId: SERVER, name: TOOL, enabled } }))
const grant = (me: AgentFetch, allowed: boolean) =>
  callOwner(me, (api) => api.mcp.setToolGrant({ payload: { serverId: SERVER, name: TOOL, allowed } }))
const approval = (me: AgentFetch, id: string) => callOwner(me, (api) => api.mcp.approval({ params: { id } }))

export async function approvalsCase(base: string): Promise<void> {
  const owner = await person(base)
  await grantPlan(base, owner)
  const me = signedIn(base, owner)
  await callOwner(me, (api) => api.mcp.connect({ params: { id: SERVER } }))
  await grant(me, true)
  await mark(me, true)
  const held = await hold(me)
  expect(await calls(base, owner)).toEqual([])
  const reviewed = await approval(me, held.id)
  expect(reviewed).toMatchObject({ state: 'pending', arguments: { ...args, accessToken: '[redacted]' } })
  expect(JSON.stringify(reviewed)).not.toContain('fixture-private')
  const other = await person(base)
  await grantPlan(base, other)
  const them = signedIn(base, other)
  expect(await answerOf(them, (api) => api.mcp.approval({ params: { id: held.id } }))).toBe('NotFound')
  expect(
    await answerOf(them, (api) => api.mcp.decideApproval({ params: { id: held.id }, payload: { allowed: true } })),
  ).toBe('NotFound')
  // Arguments the browser adds to its decision are not part of it: the call runs with the frozen ones.
  const approved = await call(base, owner, held.path, { allowed: true, arguments: { operationKey: 'browser-tamper' } })
  expect(approved.status).toBe(200)
  expect(decodeApproval(await approved.json()).state).toBe('completed')
  expect(await calls(base, owner)).toEqual([{ name: TOOL, args }])
  await decide(me, held.id, true)
  expect(await calls(base, owner)).toHaveLength(1)
  await showing(me, held.thread, 'fixture-board')

  const refused = await hold(me, { operationKey: 'op-refused' })
  expect((await decide(me, refused.id, false)).state).toBe('refused')
  await decide(me, refused.id, true)
  expect(await calls(base, owner)).toHaveLength(1)

  const revoked = await hold(me, { operationKey: 'op-revoked' })
  await grant(me, false)
  await grant(me, true)
  await mark(me, true)
  expect((await decide(me, revoked.id, true)).state).toBe('failed')
  expect(await calls(base, owner)).toHaveLength(1)

  // A held call whose tool Personal's setup no longer holds is refused when approved (ADR 0040); then it holds it again.
  const scoped = await hold(me, { operationKey: 'op-scoped' })
  const narrowed = await callOwner(me, (api) =>
    api.topics.setSetup({ params: { id: 1 }, payload: { remove: [{ kind: 'tool', serverId: SERVER, name: TOOL }] } }),
  )
  expect((await decide(me, scoped.id, true)).state).toBe('failed')
  expect(await calls(base, owner)).toHaveLength(1)
  await callOwner(me, (api) =>
    api.topics.setSetup({
      params: { id: 1 },
      payload: { set: { ...narrowed.topic.setup, mcpServers: 'all' }, expectedRevision: narrowed.topic.revision },
    }),
  )

  // App and alternate model dispatches must stop at the central seam even without the Pi hook.
  const app = await answerOf(me, (api) =>
    api.mcp.callTool({
      params: { id: SERVER },
      headers: { 'x-mcp-caller': 'app' },
      payload: { name: TOOL, arguments: {} },
    }),
  )
  // A 403: the App's own grants do not hold this tool.
  expect(['Forbidden', 'GrantDenied']).toContain(app)
  expect(await calls(base, owner)).toHaveLength(1)
  await callOwner(me, (api) =>
    api.mcp.callTool({
      params: { id: SERVER },
      headers: {},
      payload: { name: TOOL, arguments: { operationKey: 'manual-owner' } },
    }),
  )
  expect(await calls(base, owner)).toHaveLength(2)
  await approvalsBackground(base, owner)
  expect((await calls(base, owner)).map((item) => item.args)).toContainEqual({ operationKey: 'routine-frozen' })
  expect((await calls(base, owner)).map((item) => item.args)).not.toContainEqual({ operationKey: 'subagent-frozen' })
  const recovery = await (await lever(base, owner, 'approvals/recovery')).json()
  expect(recovery).toMatchObject({
    refused: ['arguments', 'session', 'endpoint', 'caller'],
    dispatching: 'dispatching',
    state: 'uncertain',
    replayRefused: true,
    exact: { operationKey: 'same-operation', rewardToken: '0x123', accessToken: 'fixture-private' },
    view: { arguments: { accessToken: '[redacted]' } },
  })
}
