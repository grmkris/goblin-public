import { expect } from 'vitest'
import { Schema } from 'effect'
import { WorkspaceState, type MemberPolicy } from '@purrable/contracts'
import { waitFor, type Person, type Ports } from './members-phaseb.ts'

const State = Schema.decodeUnknownSync(WorkspaceState)
const Inbox = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      requestHash: Schema.String,
      requesterUserId: Schema.String,
      answererUserId: Schema.String,
      kind: Schema.String,
    }),
  ),
)
async function shared(base: string, ports: Ports, role: 'member' | 'viewer' = 'member') {
  const owner = await ports.person(base)
  const workspace = State(await (await ports.call(base, owner, '/api/workspaces')).json()).active?.id
  await ports.call(base, owner, '/__test/billing/override', { userId: owner.userId, dailyTokens: 1000 })
  expect((await ports.call(base, owner, '/api/conversations')).status).toBe(200)
  const member = await add(base, ports, workspace, role)
  return { owner, member, workspace }
}
async function add(
  base: string,
  ports: Ports,
  workspace: string | undefined,
  role: 'member' | 'viewer' = 'member',
  policy: MemberPolicy = { servers: [], skills: [], mainHistory: 'own' },
) {
  const member = await ports.person(base)
  await ports.lever(base, member, 'invitation-account')
  await ports.call(base, member, '/__test/billing/override', { userId: member.userId, dailyTokens: 1000 })
  await ports.lever(base, member, 'member', { workspaceId: workspace, role, policy })
  expect(
    (await ports.call(base, member, '/api/workspaces/active', { workspaceId: workspace, context: null })).status,
  ).toBe(200)
  return member
}
const inbox = async (base: string, who: Person, ports: Ports) =>
  Inbox(await (await ports.call(base, who, '/api/interactions')).json())
const answer = (
  base: string,
  who: Person,
  ports: Ports,
  item: { id: string; requestHash: string; operationId?: string },
  input: string,
) =>
  ports.call(base, who, `/api/interactions/${encodeURIComponent(item.id)}/answer`, {
    input,
    operationId: item.operationId ?? crypto.randomUUID(),
    requestHash: item.requestHash,
  })
async function ask(base: string, who: Person, ports: Ports, answerer: 'requester' | 'owner') {
  const operationId = crypto.randomUUID()
  const input = `call ask_user ${JSON.stringify({ questions: [{ id: 'choice', prompt: 'Which day?', kind: 'text' }], answerer })}`
  const response = await ports.call(base, who, '/api/conversations/1/messages', { input, operationId })
  expect(response.status).toBe(202)
  await waitFor(base, who, '/api/conversations/1/snapshot', 'interactionId', ports)
  return { input, operationId }
}

export async function questionRoutingCase(base: string, ports: Ports): Promise<void> {
  const { owner, member, workspace } = await shared(base, ports)
  const other = await add(base, ports, workspace)
  const viewer = await add(base, ports, workspace, 'viewer')
  const submission = await ask(base, member, ports, 'requester')
  const [item] = await inbox(base, member, ports)
  expect(item).toMatchObject({ requesterUserId: member.userId, answererUserId: member.userId, kind: 'question' })
  if (item === undefined) throw new Error('Missing native question')
  expect(await inbox(base, owner, ports)).toEqual([])
  expect(await inbox(base, other, ports)).toEqual([])
  expect((await answer(base, owner, ports, item, 'wrong owner')).status).toBe(403)
  expect((await answer(base, other, ports, item, 'wrong member')).status).toBe(403)
  expect((await answer(base, viewer, ports, item, 'wrong viewer')).status).toBe(403)
  expect((await answer(base, member, ports, { ...item, requestHash: 'tampered' }, 'Monday')).status).toBe(409)
  const decision = crypto.randomUUID()
  const decided = { ...item, operationId: decision }
  expect((await answer(base, member, ports, decided, 'Monday')).status).toBe(200)
  await waitFor(base, member, '/api/conversations/1/snapshot', 'echo: Monday', ports)
  expect((await answer(base, member, ports, decided, 'Monday')).status).toBe(200)
  expect((await answer(base, member, ports, decided, 'Tuesday')).status).toBe(409)
  expect((await answer(base, member, ports, item, 'Monday')).status).toBe(409)
  expect(
    (
      await ports.call(base, member, '/api/conversations/1/messages', {
        ...submission,
        input: 'changed operation bytes',
      })
    ).status,
  ).toBe(409)
  await ask(base, member, ports, 'owner')
  const [ownerItem] = await inbox(base, owner, ports)
  if (ownerItem === undefined) throw new Error('Missing native owner question')
  expect(await inbox(base, member, ports)).toEqual([])
  expect((await answer(base, member, ports, ownerItem, 'wrong member')).status).toBe(403)
  expect((await answer(base, owner, ports, ownerItem, 'Friday')).status).toBe(200)
  await waitFor(base, member, '/api/conversations/1/snapshot', 'echo: Friday', ports)
}

export async function privateReadersCase(base: string, ports: Ports): Promise<void> {
  const { owner, member, workspace } = await shared(base, ports)
  const reader = await add(base, ports, workspace)
  const created = await ports.call(base, member, '/api/conversations', {})
  const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await created.json()).id
  expect(
    (
      await ports.call(base, member, `/api/conversations/${id}/messages`, {
        input: 'private-reader-sentinel',
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202)
  await waitFor(base, member, `/api/conversations/${id}/snapshot`, 'echo: private-reader-sentinel', ports)
  expect((await ports.call(base, reader, `/api/conversations/${id}/snapshot`)).status).toBe(404)
  expect((await ports.call(base, owner, `/api/conversations/${id}/snapshot`)).status).toBe(200)
  const headers = {
    cookie: member.cookie,
    origin: 'https://purrable.test',
    'content-type': 'application/json',
    'x-purrable-csrf': '1',
  }
  expect(
    (
      await fetch(`${base}/api/conversations/${id}/access`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ readers: [reader.userId] }),
      })
    ).status,
  ).toBe(200)
  expect((await ports.call(base, reader, `/api/conversations/${id}/snapshot`)).status).toBe(200)
  expect(
    (
      await ports.call(base, reader, `/api/conversations/${id}/messages`, {
        input: 'reader cannot instruct',
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403)
  await ports.lever(base, member, 'policy', { policy: { servers: [], skills: [], mainHistory: 'own' } })
  expect((await ports.call(base, reader, `/api/conversations/${id}/snapshot`)).status).toBe(404)
  expect((await ports.call(base, owner, `/api/conversations/${id}/snapshot`)).status).toBe(200)
  const listed = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(
    await (await ports.call(base, reader, '/api/conversations')).json(),
  )
  expect(listed.map((view) => view.id)).not.toContain(id)
}

export async function viewerRequestCase(base: string, ports: Ports): Promise<void> {
  const { owner, member: viewer } = await shared(base, ports, 'viewer')
  const usage = await (await ports.call(base, viewer, '/api/agent/usage')).json()
  expect(
    (
      await ports.call(base, viewer, '/api/access-requests', {
        operationId: crypto.randomUUID(),
        message: 'Please allow me to compose.',
      })
    ).status,
  ).toBe(202)
  const [item] = await inbox(base, owner, ports)
  expect(item?.kind).toBe('access')
  if (item === undefined) throw new Error('Missing viewer access request')
  expect((await answer(base, viewer, ports, item, 'acknowledge')).status).toBe(403)
  expect((await answer(base, owner, ports, item, 'acknowledge')).status).toBe(200)
  expect(await (await ports.call(base, viewer, '/api/agent/usage')).json()).toEqual(usage)
}

const Usage = Schema.decodeUnknownSync(Schema.Struct({ used: Schema.Number, limit: Schema.Number }))
export async function memberAllowanceCase(base: string, ports: Ports): Promise<void> {
  const { owner, workspace } = await shared(base, ports)
  const member = await ports.person(base)
  // This existing account retains its personal Agent; its shared work must debit the same account allowance.
  await ports.call(base, member, '/api/workspaces')
  await ports.call(base, member, '/__test/billing/override', { userId: member.userId, dailyTokens: 15 })
  await ports.lever(base, member, 'member', { workspaceId: workspace })
  const ownState = State(await (await ports.call(base, member, '/api/workspaces')).json())
  await ports.call(base, member, '/api/workspaces/active', { workspaceId: workspace, context: ownState.context })
  const ownerBefore = Usage(await (await ports.call(base, owner, '/api/agent/usage')).json())
  expect(
    (
      await ports.call(base, member, '/api/conversations/1/messages', {
        input: 'charge-the-acting-member',
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202)
  await waitFor(base, member, '/api/conversations/1/snapshot', 'echo: charge-the-acting-member', ports)
  const memberUsage = Usage(await (await ports.call(base, member, '/api/agent/usage')).json())
  expect(memberUsage).toMatchObject({ used: 15, limit: 15 })
  expect(Usage(await (await ports.call(base, owner, '/api/agent/usage')).json())).toEqual(ownerBefore)
  expect(
    (
      await ports.call(base, member, '/api/conversations/1/messages', {
        input: 'over-account-allowance',
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(429)
}

export async function memberStreamRevocationCase(base: string, ports: Ports): Promise<void> {
  const { member } = await shared(base, ports)
  const controller = new AbortController()
  const response = await fetch(`${base}/api/conversations/1/events`, {
    headers: { cookie: member.cookie },
    signal: controller.signal,
  })
  expect(response.status).toBe(200)
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('Missing native member stream')
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot')
    await ports.lever(base, member, 'revoke')
    let done = false
    while (!done) done = (await reader.read()).done
    expect(controller.signal.aborted).toBe(false)
    expect((await ports.call(base, member, '/api/conversations/1/snapshot')).status).toBe(404)
  } finally {
    clearTimeout(timer)
    controller.abort()
    reader.releaseLock()
  }
}

export async function lateInvalidationCase(base: string, ports: Ports): Promise<void> {
  const { owner, member } = await shared(base, ports)
  await ask(base, member, ports, 'requester')
  const [old] = await inbox(base, member, ports)
  const state = State(await (await ports.call(base, member, '/api/workspaces')).json())
  await ports.lever(base, member, 'policy', { policy: { servers: [], skills: [], mainHistory: 'own' } })
  await ask(base, member, ports, 'requester')
  const [current] = await inbox(base, member, ports)
  expect(current?.id).not.toBe(old?.id)
  await ports.lever(base, owner, 'invalidate', { memberId: state.active?.memberId })
  expect(await inbox(base, member, ports)).toEqual([current])
  if (current === undefined) throw new Error('Missing current membership question')
  expect((await answer(base, member, ports, current, 'new-version-answer')).status).toBe(200)
}

export async function historyDowngradeCase(base: string, ports: Ports): Promise<void> {
  const { owner, member } = await shared(base, ports)
  const sentinel = `authorized-root-${crypto.randomUUID()}`
  await ports.call(base, owner, '/api/conversations/1/messages', { input: sentinel, operationId: crypto.randomUUID() })
  await waitFor(base, owner, '/api/conversations/1/snapshot', `echo: ${sentinel}`, ports)
  await ports.lever(base, member, 'policy', { policy: { servers: [], skills: [], mainHistory: 'all' } })
  expect(await (await ports.call(base, member, '/api/conversations/1/snapshot')).text()).toContain(sentinel)
  const views = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(
    await (await ports.call(base, owner, '/api/conversations')).json(),
  )
  const previous = views.find((view) => view.id !== '1')?.id
  if (previous === undefined) throw new Error('Missing full-history member context')
  await ports.lever(base, member, 'policy', { policy: { servers: [], skills: [], mainHistory: 'own' } })
  expect(await (await ports.call(base, member, '/api/conversations/1/snapshot')).text()).not.toContain(sentinel)
  expect((await ports.call(base, member, `/api/conversations/${previous}/snapshot`)).status).toBe(404)
  expect(await (await ports.call(base, owner, `/api/conversations/${previous}/snapshot`)).text()).toContain(sentinel)
}

export async function memberDescendantsCase(base: string, ports: Ports): Promise<void> {
  const { owner, member } = await shared(base, ports)
  const before = Usage(await (await ports.call(base, owner, '/api/agent/usage')).json())
  const input = `call subagent ${JSON.stringify({ action: 'spawn', name: 'member-child', message: 'descendant-account-marker' })}`
  expect(
    (await ports.call(base, member, '/api/conversations/1/messages', { input, operationId: crypto.randomUUID() }))
      .status,
  ).toBe(202)
  await waitFor(base, member, '/api/conversations/1/snapshot', 'descendant-account-marker', ports)
  // The relay reports the child's answer into the member's own context: their authority still holds.
  await until(base, member, '/api/conversations/1/snapshot', ports, (text) =>
    text.includes('[from subagent member-child]'),
  )
  const views = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String })))(
    await (await ports.call(base, member, '/api/conversations')).json(),
  )
  const child = views.find((view) => view.kind === 'subagent')
  if (child === undefined) throw new Error('Missing member descendant')
  expect(await (await ports.call(base, member, `/api/conversations/${child.id}/snapshot`)).text()).toContain(
    `purrable-member:${child.id}`,
  )
  expect(Usage(await (await ports.call(base, member, '/api/agent/usage')).json()).used).toBeGreaterThanOrEqual(45)
  expect(Usage(await (await ports.call(base, owner, '/api/agent/usage')).json())).toEqual(before)
  await ports.lever(base, member, 'revoke')
  expect((await ports.call(base, member, `/api/conversations/${child.id}/snapshot`)).status).toBe(404)
}

/** Reads `path` as `who` every 100 ms, for up to 15 s, until `done` holds for its text. */
async function until(base: string, who: Person, path: string, ports: Ports, done: (text: string) => boolean) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const text = await (await ports.call(base, who, path)).text()
    if (done(text)) return text
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out reading ${path}`)
}

const Listed = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.optional(Schema.String), parent: Schema.optional(Schema.String) }),
  ),
)

/**
 * A relay checks the member's authority again before it reports: a member revoked while their subagent works never
 * hears its answer, though the subagent finished it.
 */
export async function memberRelayAuthorityCase(base: string, ports: Ports): Promise<void> {
  const { owner, member } = await shared(base, ports)
  const input = `call subagent ${JSON.stringify({ action: 'spawn', name: 'member-slow', message: 'member slow job' })}`
  expect(
    (await ports.call(base, member, '/api/conversations/1/messages', { input, operationId: crypto.randomUUID() }))
      .status,
  ).toBe(202)
  const listed = await until(base, owner, '/api/conversations', ports, (text) => text.includes('"member-slow"'))
  const child = Listed(JSON.parse(listed)).find((view) => view.title === 'member-slow')
  if (child?.parent === undefined) throw new Error('Missing member subagent')
  // Its model request is under way (the fixture takes three seconds to answer it); then the member loses access.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await ports.lever(base, member, 'revoke')
  await until(base, owner, `/api/conversations/${child.id}/snapshot`, ports, (text) =>
    text.includes('echo: member slow job'),
  )
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const spawner = await (await ports.call(base, owner, `/api/conversations/${child.parent}/snapshot`)).text()
  expect(spawner).not.toContain('[from subagent member-slow]')
}
