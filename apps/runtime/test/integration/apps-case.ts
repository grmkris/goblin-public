import { expect } from 'vitest'
import { type AgentFetch, type OwnerClient, callOwner } from '../owner-client.ts'
import { BOARD } from './apps-mcp.ts'
import { call, grantPlan, person, showing, signedIn, workspaceOf, type Person } from './owner-requests.ts'
import { answerOf } from './probe-reads.ts'

/** What an App the owner opened sends with its calls: it is held to the App's grants, not the owner's. */
const APP_CALLER = { 'x-mcp-caller': 'app' }

const grant = (me: AgentFetch, allowed: boolean) =>
  callOwner(me, (api) => api.mcp.setToolGrant({ payload: { connectionId: 'apps-fixture', name: 'board', allowed } }))
/** The board's resource, read as the App reads it. */
const read = (api: OwnerClient) =>
  api.mcp.readResource({ params: { id: 'apps-fixture' }, headers: APP_CALLER, payload: { uri: BOARD } })

/** The board App, kept from a call in a new thread of `owner`'s, as the workspace shows it. */
async function keptApp(base: string, owner: Person) {
  const me = signedIn(base, owner)
  const thread = await callOwner(me, (api) => api.conversations.create({ payload: {} }))
  const input = `call mcp_call ${JSON.stringify({ connectionId: 'apps-fixture', name: 'board', arguments: { marker: 'kept' } })}`
  await callOwner(me, (api) =>
    api.conversations.submit({ params: { id: thread.id }, payload: { input, operationId: crypto.randomUUID() } }),
  )
  await showing(me, thread.id, 'fixture-board')
  const [app] = (await workspaceOf(base, owner)).apps
  expect(app).toMatchObject({
    conversation: thread.id,
    title: 'Board',
    source: { kind: 'mcp', connectionId: 'apps-fixture', tool: 'board', uri: BOARD },
  })
  if (app === undefined) throw new Error('no app kept')
  return { app, thread: thread.id }
}

/** With the grant gone, the App's resource and tool are refused, and an edge refusal applies no grant either. */
async function grantsLive(base: string, owner: Person): Promise<void> {
  const me = signedIn(base, owner)
  await grant(me, false)
  expect(await answerOf(me, read)).toBe('GrantDenied')
  const deniedCall = await answerOf(me, (api) =>
    api.mcp.callTool({
      params: { id: 'apps-fixture' },
      headers: APP_CALLER,
      payload: { name: 'board', arguments: {} },
    }),
  )
  expect(deniedCall).toBe('GrantDenied')
  const grants = await callOwner(me, (api) => api.mcp.grants())
  expect(JSON.stringify(grants)).not.toContain('"name":"board"')
  for (const headers of [{ origin: '' }, { 'x-goblin-csrf': '' }]) {
    const refused = await call(
      base,
      owner,
      '/api/mcp/grants',
      { connectionId: 'apps-fixture', name: 'board', allowed: true },
      headers,
    )
    expect(refused.status).toBe(403)
  }
}

/**
 * The owner's App is kept per call (ADR 0020): the call registers it under its conversation, launch reads the call
 * back, Close of the conversation closes it, showing it again reopens the same App, and its resource is checked
 * against the owner's grants live (reopening restores none).
 */
export async function appsCase(base: string): Promise<void> {
  const owner = await person(base)
  await grantPlan(base, owner)
  const me = signedIn(base, owner)
  await callOwner(me, (api) => api.mcp.connect({ params: { id: 'apps-fixture' } }))
  await grant(me, true)
  const { app, thread } = await keptApp(base, owner)
  const launch = await callOwner(me, (api) => api.apps.launch({ params: { id: app.id } }))
  expect(launch).toMatchObject({ kind: 'mcp', connectionId: 'apps-fixture', uri: BOARD, arguments: { marker: 'kept' } })
  expect(JSON.stringify(launch.kind === 'mcp' ? launch.result : null)).toContain('fixture-board')
  await callOwner(me, read)
  const crossed = await answerOf(me, (api) =>
    api.conversations.submit({
      params: { id: '1' },
      payload: {
        input: 'Continue with the saved MyPlan answer.',
        operationId: crypto.randomUUID(),
        appContext: [{ app: app.id, text: 'receipt from another conversation' }],
      },
    }),
  )
  expect(crossed).toBe('NotFound')
  await callOwner(me, (api) => api.conversations.update({ params: { id: thread }, payload: { closed: true } }))
  expect((await workspaceOf(base, owner)).apps[0]?.closedAt).toBeDefined()
  const callId = app.source.kind === 'mcp' ? app.source.callId : ''
  const reopened = await callOwner(me, (api) => api.apps.create({ payload: { conversation: thread, callId } }))
  expect(reopened).toMatchObject({ id: app.id })
  expect(reopened).not.toHaveProperty('closedAt')
  await grantsLive(base, owner)
  expect(await answerOf(me, (api) => api.apps.launch({ params: { id: '999999' } }))).toBe('NotFound')
}
