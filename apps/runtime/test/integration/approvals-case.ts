import { approvalsBackground } from './approvals-background.ts'
import { expect } from 'vitest'
import { Predicate, Schema } from 'effect'
import { ApprovalView, ConversationView } from '@goblin/contracts'
import { person, call, waitFor, type Person } from './owner-requests.ts'

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
const send = (base: string, owner: Person, path: string, method: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: owner.cookie,
      origin: 'https://goblin.test',
      'content-type': 'application/json',
      'x-goblin-csrf': '1',
    },
    body: JSON.stringify(body),
  })
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
async function hold(base: string, owner: Person, inputArgs: unknown = args) {
  const thread = Schema.decodeUnknownSync(ConversationView)(
    await (await call(base, owner, '/api/conversations', {})).json(),
  )
  expect(
    (
      await call(base, owner, `/api/conversations/${thread.id}/messages`, {
        input: `call mcp_call ${JSON.stringify({ serverId: SERVER, name: TOOL, arguments: inputArgs })}`,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202)
  const snapshot = await waitFor(base, owner, `/api/conversations/${thread.id}/snapshot`, 'approval-required')
  const id = approvalId(JSON.parse(snapshot))
  if (id === undefined) throw new Error('missing held call')
  return { id, thread: thread.id, path: `/api/mcp/approvals/${encodeURIComponent(id)}` }
}
const calls = async (base: string, owner: Person) =>
  decodeCalls(await (await call(base, owner, '/__test/approvals/calls')).json())
const mark = (base: string, owner: Person, enabled: boolean) =>
  send(base, owner, '/api/mcp/ask-first', 'PUT', { serverId: SERVER, name: TOOL, enabled })
const grant = (base: string, owner: Person, allowed: boolean) =>
  send(base, owner, '/api/mcp/grants', 'PUT', { serverId: SERVER, name: TOOL, allowed })

export async function approvalsCase(base: string): Promise<void> {
  const owner = await person(base)
  await call(base, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
  expect((await call(base, owner, `/api/mcp/${SERVER}/connect`, {})).status).toBe(200)
  expect((await grant(base, owner, true)).status).toBe(200)
  expect((await mark(base, owner, true)).status).toBe(200)
  const held = await hold(base, owner)
  expect(await calls(base, owner)).toEqual([])
  const reviewed = decodeApproval(await (await call(base, owner, held.path)).json())
  expect(reviewed).toMatchObject({ state: 'pending', arguments: { ...args, accessToken: '[redacted]' } })
  expect(JSON.stringify(reviewed)).not.toContain('fixture-private')
  const other = await person(base)
  await call(base, other, '/__test/billing/override', { userId: other.userId, dailyCredits: 1000 })
  expect((await call(base, other, held.path)).status).toBe(404)
  expect((await call(base, other, held.path, { allowed: true })).status).toBe(404)
  const approved = await call(base, owner, held.path, { allowed: true, arguments: { operationKey: 'browser-tamper' } })
  expect(approved.status).toBe(200)
  expect(decodeApproval(await approved.json()).state).toBe('completed')
  expect(await calls(base, owner)).toEqual([{ name: TOOL, args }])
  await call(base, owner, held.path, { allowed: true })
  expect(await calls(base, owner)).toHaveLength(1)
  await waitFor(base, owner, `/api/conversations/${held.thread}/snapshot`, 'fixture-board')

  const refused = await hold(base, owner, { operationKey: 'op-refused' })
  expect(decodeApproval(await (await call(base, owner, refused.path, { allowed: false })).json()).state).toBe('refused')
  await call(base, owner, refused.path, { allowed: true })
  expect(await calls(base, owner)).toHaveLength(1)

  const revoked = await hold(base, owner, { operationKey: 'op-revoked' })
  await grant(base, owner, false)
  await grant(base, owner, true)
  await mark(base, owner, true)
  expect(decodeApproval(await (await call(base, owner, revoked.path, { allowed: true })).json()).state).toBe('failed')
  expect(await calls(base, owner)).toHaveLength(1)

  const scoped = await hold(base, owner, { operationKey: 'op-scoped' })
  expect(
    (
      await send(base, owner, `/api/conversations/${scoped.thread}/capabilities`, 'PATCH', {
        target: { kind: 'tool', serverId: SERVER, name: TOOL },
        on: false,
      })
    ).status,
  ).toBe(200)
  expect(decodeApproval(await (await call(base, owner, scoped.path, { allowed: true })).json()).state).toBe('failed')
  expect(await calls(base, owner)).toHaveLength(1)

  // App and alternate model dispatches must stop at the central seam even without the Pi hook.
  const app = await call(
    base,
    owner,
    `/api/mcp/${SERVER}/tools/call`,
    { name: TOOL, arguments: {} },
    { 'x-mcp-caller': 'app' },
  )
  expect(app.status).toBe(403)
  expect(await calls(base, owner)).toHaveLength(1)
  const human = await call(base, owner, `/api/mcp/${SERVER}/tools/call`, {
    name: TOOL,
    arguments: { operationKey: 'manual-owner' },
  })
  expect(human.status).toBe(200)
  expect(await calls(base, owner)).toHaveLength(2)
  await approvalsBackground(base, owner)
  expect((await calls(base, owner)).map((item) => item.args)).toContainEqual({ operationKey: 'routine-frozen' })
  expect((await calls(base, owner)).map((item) => item.args)).not.toContainEqual({ operationKey: 'subagent-frozen' })
  const recovery = await (await call(base, owner, '/__test/approvals/recovery')).json()
  expect(recovery).toMatchObject({
    refused: ['arguments', 'session', 'endpoint', 'caller'],
    dispatching: 'dispatching',
    state: 'uncertain',
    replayRefused: true,
    exact: { operationKey: 'same-operation', rewardToken: '0x123', accessToken: 'fixture-private' },
    view: { arguments: { accessToken: '[redacted]' } },
  })
}
