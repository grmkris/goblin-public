import { expect } from 'vitest'
import { Schema } from 'effect'
import { WorkspaceState } from '@purrable/contracts'

type Person = { readonly userId: string; readonly cookie: string; readonly ip: string; readonly email: string }
type Ports = {
  readonly person: (base: string) => Promise<Person>
  readonly call: (
    base: string,
    person: Person,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>
  readonly pay: (base: string, person: Person) => Promise<Response>
  readonly lever: (base: string, person: Person, action: string, extra?: Record<string, unknown>) => Promise<Response>
}
const State = Schema.decodeUnknownSync(WorkspaceState)
const Receipt = Schema.decodeUnknownSync(Schema.Struct({ session: Schema.String }))
const View = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.optional(Schema.String) })),
)
async function waitFor(base: string, who: Person, path: string, expected: string, ports: Ports): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await ports.call(base, who, path)
    expect(response.status).toBe(200)
    const value = await response.text()
    if (value.includes(expected)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`missing fixture response ${expected}`)
}

export async function memberContextsCase(base: string, ports: Ports): Promise<void> {
  const owner = await ports.person(base)
  const shared = State(await (await ports.call(base, owner, '/api/workspaces')).json())
  await ports.pay(base, owner)
  const sentinel = `owner-private-main-${crypto.randomUUID()}`
  expect(
    (
      await ports.call(base, owner, '/api/conversations/1/messages', {
        input: sentinel,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202)
  await waitFor(base, owner, '/api/conversations/1/snapshot', `echo: ${sentinel}`, ports)
  const ownSecret = `owner-private-thread-${crypto.randomUUID()}`
  const created = await ports.call(base, owner, '/api/conversations', {})
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await created.json()).id
  expect(
    (
      await ports.call(base, owner, `/api/conversations/${id}/messages`, {
        input: ownSecret,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202)
  await waitFor(base, owner, `/api/conversations/${id}/snapshot`, `echo: ${ownSecret}`, ports)
  const member = await ports.person(base)
  await ports.lever(base, member, 'invitation-account')
  await ports.pay(base, member)
  await ports.lever(base, member, 'member', { workspaceId: shared.active?.id })
  const selection = await ports.call(base, member, '/api/workspaces/active', {
    workspaceId: shared.active?.id,
    context: null,
  })
  expect(selection.status).toBe(200)
  const response = await ports.call(base, member, '/api/conversations/1/messages', {
    input: 'member-private-hello',
    operationId: crypto.randomUUID(),
  })
  expect(response.status).toBe(202)
  const receipt = Receipt(await response.json())
  expect(receipt.session).not.toBe('1')
  const text = await waitFor(base, member, '/api/conversations/1/snapshot', 'echo: member-private-hello', ports)
  expect(text).not.toContain(sentinel)
  expect(text).not.toContain(ownSecret)
  expect((await ports.call(base, member, `/api/conversations/${id}/snapshot`)).status).toBe(404)
  const ownerRead = await waitFor(
    base,
    owner,
    `/api/conversations/${receipt.session}/snapshot`,
    'member-private-hello',
    ports,
  )
  expect(ownerRead).toContain('member-private-hello')
  const root = await waitFor(base, owner, '/api/conversations/1/snapshot', 'member-private-hello', ports)
  expect(root).toContain('app.member_exchange')
  const ownerTree = View(await (await ports.call(base, owner, '/api/conversations')).json())
  expect(ownerTree.some((view) => view.id === receipt.session)).toBe(true)
  for (const path of ['/api/agent/resident', '/api/agent/channel', '/api/mcp/servers', '/api/routines'])
    expect((await ports.call(base, member, path)).status).toBe(404)
  await ports.lever(base, member, 'revoke')
  expect((await ports.call(base, member, '/api/conversations/1/snapshot')).status).toBe(404)
}

export async function memberViewerCase(base: string, ports: Ports): Promise<void> {
  const owner = await ports.person(base)
  const shared = State(await (await ports.call(base, owner, '/api/workspaces')).json())
  await ports.pay(base, owner)
  const viewer = await ports.person(base)
  await ports.lever(base, viewer, 'invitation-account')
  await ports.pay(base, viewer)
  await ports.lever(base, viewer, 'member', { workspaceId: shared.active?.id, role: 'viewer' })
  await ports.call(base, viewer, '/api/workspaces/active', { workspaceId: shared.active?.id, context: null })
  expect((await ports.call(base, viewer, '/api/conversations/1/snapshot')).status).toBe(200)
  expect(
    (
      await ports.call(base, viewer, '/api/conversations/1/messages', {
        input: 'viewer compose denied',
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403)
  expect((await ports.call(base, viewer, '/api/conversations/1/stop', {})).status).toBe(403)
  expect((await ports.call(base, viewer, '/api/agent/channel', { serverId: 'telegram' })).status).toBe(404)
  expect((await ports.call(base, viewer, '/api/conversations')).status).toBe(200)
}
