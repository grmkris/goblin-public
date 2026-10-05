import { expect } from 'vitest'
import { Schema } from 'effect'
import { WorkspaceState } from '@purrable/contracts'
import { waitFor, type Ports, type Person } from './members-phaseb.ts'

const Inbox = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, requestHash: Schema.String })))
const Calls = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.Unknown })))
const stats = async (base: string, owner: Person, ports: Ports) =>
  Calls(await (await ports.lever(base, owner, 'mcp-stats')).json())
async function granted(base: string, owner: Person, name: string) {
  const response = await fetch(`${base}/api/mcp/grants`, {
    method: 'PUT',
    headers: { cookie: owner.cookie, origin: 'https://purrable.test', 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: 'members-fixture', name, allowed: true }),
  })
  expect(response.status).toBe(200)
}
async function turn(base: string, member: Person, ports: Ports, name: string, marker: string) {
  const response = await ports.call(base, member, '/api/conversations/1/messages', {
    input: `call mcp_call ${JSON.stringify({ serverId: 'members-fixture', name, arguments: { marker } })}`,
    operationId: crypto.randomUUID(),
  })
  expect(response.status).toBe(202)
}
async function approval(base: string, owner: Person, ports: Ports) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = Inbox(await (await ports.call(base, owner, '/api/interactions')).json())
    if (rows[0] !== undefined) return rows[0]
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Missing native approval receipt')
}
export async function memberToolsCase(base: string, ports: Ports): Promise<void> {
  const owner = await ports.person(base)
  const workspace = Schema.decodeUnknownSync(WorkspaceState)(
    await (await ports.call(base, owner, '/api/workspaces')).json(),
  ).active?.id
  await ports.call(base, owner, '/__test/billing/override', { userId: owner.userId, dailyTokens: 1000 })
  expect((await ports.call(base, owner, '/api/mcp/members-fixture/connect', {})).status).toBe(200)
  await granted(base, owner, 'read')
  await granted(base, owner, 'write')
  const member = await ports.person(base)
  await ports.lever(base, member, 'invitation-account')
  await ports.call(base, member, '/__test/billing/override', { userId: member.userId, dailyTokens: 1000 })
  await ports.lever(base, member, 'member', {
    workspaceId: workspace,
    policy: {
      servers: [
        { serverId: 'members-fixture', endpoint: 'https://members-fixture.test/mcp', tools: ['read', 'missinggrant'] },
      ],
      skills: [],
      mainHistory: 'own',
    },
  })
  await ports.call(base, member, '/api/workspaces/active', { workspaceId: workspace, context: null })
  await turn(base, member, ports, 'read', 'allowed')
  await waitFor(base, member, '/api/conversations/1/snapshot', 'fixture-read', ports)
  expect(await stats(base, owner, ports)).toEqual([{ name: 'read', args: { marker: 'allowed' } }])
  await turn(base, member, ports, 'missinggrant', 'sealed')
  const receipt = await approval(base, owner, ports)
  expect(await stats(base, owner, ports)).toHaveLength(1)
  const path = `/api/interactions/${encodeURIComponent(receipt.id)}/answer`
  const body = { input: 'allow_once', requestHash: receipt.requestHash, operationId: crypto.randomUUID() }
  expect((await ports.call(base, member, path, body)).status).toBe(403)
  expect((await ports.call(base, owner, path, body)).status).toBe(409)
  expect(await stats(base, owner, ports)).toHaveLength(1)
  await granted(base, owner, 'missinggrant')
  expect((await ports.call(base, owner, path, body)).status).toBe(200)
  await waitFor(base, member, '/api/conversations/1/snapshot', 'app.member_decision', ports)
  expect(await stats(base, owner, ports)).toEqual([
    { name: 'read', args: { marker: 'allowed' } },
    { name: 'missinggrant', args: { marker: 'sealed' } },
  ])
  expect((await ports.call(base, owner, path, body)).status).toBe(200)
  expect(await stats(base, owner, ports)).toHaveLength(2)
  expect((await ports.call(base, owner, path, { ...body, input: 'deny' })).status).toBe(409)
  await turn(base, member, ports, 'write', 'outside-ceiling')
  const denied = await approval(base, owner, ports)
  expect(
    (
      await ports.call(base, owner, `/api/interactions/${encodeURIComponent(denied.id)}/answer`, {
        input: 'allow_once',
        requestHash: denied.requestHash,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409)
  expect(await stats(base, owner, ports)).toHaveLength(2)
  expect(
    (
      await ports.call(base, owner, `/api/interactions/${encodeURIComponent(denied.id)}/answer`, {
        input: 'deny',
        requestHash: denied.requestHash,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200)
}
