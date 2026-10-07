import { expect } from 'vitest'
import { Schema } from 'effect'
import { AppLaunch, ConversationView, HomeEditResult, HomeRead, WorkspaceSnapshot } from '@goblin/contracts'
import { BOARD } from './apps-mcp.ts'
import { person, call, ownerFetch, waitFor, type Person } from './owner-requests.ts'

/** An owner request with any method (the harness's `call` only GETs and POSTs). */
const send = (base: string, who: Person, path: string, method: string, body?: unknown) =>
  ownerFetch(`${base}${path}`, {
    method,
    headers: {
      cookie: who.cookie,
      origin: 'https://goblin.test',
      'content-type': 'application/json',
      'x-goblin-csrf': '1',
      'cf-connecting-ip': who.ip,
      'x-mcp-caller': 'app',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const grant = async (base: string, owner: Person, allowed: boolean) =>
  expect(
    (await send(base, owner, '/api/mcp/grants', 'PUT', { serverId: 'apps-fixture', name: 'board', allowed })).status,
  ).toBe(200)

/** The workspace feed's first event: every conversation and App now. */
async function snapshot(base: string, owner: Person): Promise<WorkspaceSnapshot> {
  const response = await send(base, owner, '/api/workspace/events', 'GET')
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (let read = await reader?.read(); read !== undefined && !read.done; read = await reader?.read()) {
    buffer += decoder.decode(read.value, { stream: true })
    const frame = buffer.split('\n\n').find((part) => part.includes('event: snapshot'))
    const data = frame === undefined ? undefined : /^data: (.*)$/mu.exec(frame)?.[1]
    if (data !== undefined) {
      await reader?.cancel()
      return Schema.decodeUnknownSync(WorkspaceSnapshot)(JSON.parse(data))
    }
  }
  throw new Error('no workspace snapshot')
}

/**
 * The owner's App is kept per call (ADR 0020): the call registers it under its conversation, launch reads the call
 * back, Close of the conversation closes it, showing it again reopens the same App, and its resource is checked
 * against the owner's grants live (reopening restores none).
 */
export async function appsCase(base: string): Promise<void> {
  const owner = await person(base)
  await call(base, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
  expect((await call(base, owner, '/api/mcp/apps-fixture/connect', {})).status).toBe(200)
  await grant(base, owner, true)
  const thread = Schema.decodeUnknownSync(ConversationView)(
    await (await call(base, owner, '/api/conversations', {})).json(),
  )
  const input = `call mcp_call ${JSON.stringify({ serverId: 'apps-fixture', name: 'board', arguments: { marker: 'kept' } })}`
  await call(base, owner, `/api/conversations/${thread.id}/messages`, { input, operationId: crypto.randomUUID() })
  await waitFor(base, owner, `/api/conversations/${thread.id}/snapshot`, 'fixture-board')
  const [app] = (await snapshot(base, owner)).apps
  expect(app).toMatchObject({
    conversation: thread.id,
    title: 'Board',
    source: { kind: 'mcp', serverId: 'apps-fixture', tool: 'board', uri: BOARD },
  })
  if (app === undefined) throw new Error('no app kept')
  const launch = Schema.decodeUnknownSync(AppLaunch)(
    await (await send(base, owner, `/api/apps/${app.id}/launch`, 'GET')).json(),
  )
  expect(launch).toMatchObject({ kind: 'mcp', serverId: 'apps-fixture', uri: BOARD, arguments: { marker: 'kept' } })
  expect(JSON.stringify(launch.kind === 'mcp' ? launch.result : null)).toContain('fixture-board')
  const html = await send(base, owner, '/api/mcp/apps-fixture/resources/read', 'POST', { uri: BOARD })
  expect(html.status).toBe(200)
  const initialHome = Schema.decodeUnknownSync(HomeRead)(await (await call(base, owner, '/api/home')).json())
  const pinInput = {
    operationId: crypto.randomUUID(),
    expectedRevision: initialHome.layout.revision,
    ops: [{ kind: 'add', tile: { kind: 'app', appId: app.id, id: 'fixture-home-app', size: 'medium' } }],
  }
  const pinned = await call(base, owner, '/api/home', pinInput)
  expect(pinned.status).toBe(200)
  const home = Schema.decodeUnknownSync(HomeEditResult)(await pinned.json())
  expect(home).toMatchObject({
    kind: 'applied',
    layout: { tiles: [expect.objectContaining({ appId: app.id, placedBy: 'owner' })] },
  })

  expect((await send(base, owner, `/api/conversations/${thread.id}`, 'PATCH', { closed: true })).status).toBe(200)
  expect((await snapshot(base, owner)).apps[0]?.closedAt).toBeDefined()
  const callId = app.source.kind === 'mcp' ? app.source.callId : ''
  const reopened = await (await call(base, owner, '/api/apps', { conversation: thread.id, callId })).json()
  expect(reopened).toMatchObject({ id: app.id })
  expect(reopened).not.toHaveProperty('closedAt')

  await grant(base, owner, false)
  const denied = await send(base, owner, '/api/mcp/apps-fixture/resources/read', 'POST', { uri: BOARD })
  expect(denied.status).toBeGreaterThanOrEqual(400)
  expect(await denied.text()).toContain('GrantDenied')
  const deniedCall = await send(base, owner, '/api/mcp/apps-fixture/tools/call', 'POST', {
    name: 'board',
    arguments: {},
  })
  expect(deniedCall.status).toBeGreaterThanOrEqual(400)
  expect(await deniedCall.text()).toContain('GrantDenied')
  expect(Schema.decodeUnknownSync(HomeRead)(await (await call(base, owner, '/api/home')).json()).layout).toEqual(
    home.kind === 'applied' ? home.layout : undefined,
  )
  const replay = await call(base, owner, '/api/home', pinInput)
  expect(replay.status).toBe(200)
  expect(Schema.decodeUnknownSync(HomeEditResult)(await replay.json())).toEqual(home)
  const grants = await (await call(base, owner, '/api/mcp/grants')).json()
  expect(JSON.stringify(grants)).not.toContain('"name":"board"')
  for (const headers of [{ origin: '' }, { 'x-goblin-csrf': '' }]) {
    const refused = await call(
      base,
      owner,
      '/api/mcp/grants',
      { serverId: 'apps-fixture', name: 'board', allowed: true },
      headers,
    )
    expect(refused.status).toBe(403)
  }
  expect((await send(base, owner, '/api/apps/999999/launch', 'GET')).status).toBe(404)
}
