import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as Redacted from 'effect/Redacted'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DevClient, type Step } from '../../scripts/smoke-client.ts'

const OWNER = 'owner@example.com'
const COOKIE = 'better-auth.session_token=secret-value'
const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = []

const answer = (response: ServerResponse, status: number, body: unknown, ref?: string): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...(ref === undefined ? {} : { 'x-goblin-ref': ref }),
  })
  response.end(JSON.stringify(body))
}

/** A stand-in for the stage: the session read, two owner endpoints, and a failure in the error envelope. */
const server = createServer((request, response) => {
  seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers })
  const route = `${request.method} ${request.url}`
  if (route === 'GET /api/auth/get-session')
    return answer(response, 200, { user: { email: OWNER }, session: { expiresAt: '2999-01-01T00:00:00Z' } })
  if (route === 'GET /api/agent/resident') return answer(response, 200, { state: 'active' }, 'ref-resident')
  if (route === 'PUT /api/agent/model')
    return answer(response, 200, { current: 'm', default: 'm', options: [] }, 'ref-model')
  const missing = { error: { code: 'not_found', message: 'That does not exist.', what: 'chat', ref: 'ref-missing' } }
  return answer(response, 404, missing, 'ref-missing')
})

const dir = mkdtempSync(path.join(tmpdir(), 'goblin-smoke-client-'))
let dev: DevClient
const steps: Step[] = []

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  const origin = `http://localhost:${address.port}`
  const file = path.join(dir, 'session.json')
  writeFileSync(file, JSON.stringify({ origin, cookie: COOKIE }))
  chmodSync(file, 0o600)
  dev = new DevClient(new URL(origin), steps)
  await dev.useSession(file, Redacted.make(OWNER))
})
afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('DevClient', () => {
  it('sends typed owner calls with the session, a request id and CSRF on writes, and logs each answer', async () => {
    seen.length = 0
    expect((await dev.owner((api) => api.resident.status())).state).toBe('active')
    expect((await dev.owner((api) => api.agent.chooseModel({ payload: { model: 'm' } }))).current).toBe('m')
    const [read, write] = seen
    expect(read?.headers).toMatchObject({ cookie: COOKIE, origin: expect.stringMatching(/^http:\/\/localhost:/u) })
    expect(read?.headers['x-goblin-request']).toMatch(/^[0-9a-f]{8}$/u)
    expect(read?.headers['x-goblin-csrf']).toBeUndefined()
    expect(write?.headers['x-goblin-csrf']).toBe('1')
    expect(steps.slice(-2)).toEqual([
      { step: 'GET /api/agent/resident', status: 200, ref: 'ref-resident' },
      { step: 'PUT /api/agent/model', status: 200, ref: 'ref-model' },
    ])
  })

  it('reports a refused call by its tag, never its text, and logs its reference', async () => {
    await expect(dev.owner((api) => api.conversations.snapshot({ params: { id: '7' } }))).rejects.toThrow(
      /^request_failed: NotFound$/u,
    )
    expect(steps.at(-1)).toEqual({ step: 'GET /api/conversations/7/snapshot', status: 404, ref: 'ref-missing' })
  })

  it('leaves the session out of a request that asks for it', async () => {
    seen.length = 0
    await dev.send('/health', { owner: false })
    expect(seen[0]?.headers.cookie).toBeUndefined()
    expect(steps.at(-1)).toEqual({ step: 'GET /health', status: 404, ref: 'ref-missing' })
  })
})
