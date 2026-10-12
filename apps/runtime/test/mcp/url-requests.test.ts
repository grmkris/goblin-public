import { afterEach, describe, expect, it } from 'vitest'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { urlRequestId } from '../../src/mcp/approvals.ts'
import { type HeldUrlRequest, McpUrlRequestStore } from '../../src/mcp/url-requests.ts'
import { appMcpUrlRequests } from '../../src/storage/mcp-url-requests.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const key = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)))
const store = async () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  return { db, store: new McpUrlRequestStore(durable(db), await CredentialCipher.fromBase64(key)) }
}

/** `create_agent` on Sidequest, answered "input required: open this URL" (ADR 0042). */
const held = (overrides: Partial<HeldUrlRequest> = {}): HeldUrlRequest => ({
  id: urlRequestId('41', 'c1'),
  sessionId: '41',
  sourceCallId: 'c1',
  taskId: 't1',
  connectionId: 'sidequest',
  name: 'create_agent',
  endpoint: 'https://sidequest.test/mcp',
  arguments: { name: 'Worker' },
  inputKey: 'approval',
  requestState: 'op_1',
  url: 'https://sidequest.test/approve/op_1?token=one-time',
  message: 'Approve the new agent.',
  expiresAt: 10_000,
  ...overrides,
})

describe('URL requests as goblin keeps them (unit, ADR 0042)', () => {
  it('seals the arguments, the request state and the link, and opens them again only through the store', async () => {
    const { db, store: requests } = await store()
    await requests.hold(held(), 1000)
    const [row] = db.select().from(appMcpUrlRequests).all()
    expect(row).toMatchObject({ state: 'pending', inputKey: 'approval', connectionId: 'sidequest' })
    const stored = JSON.stringify(row)
    for (const secret of ['one-time', 'op_1', 'Worker', 'Approve the new agent']) expect(stored).not.toContain(secret)
    expect(await requests.arguments(held().id)).toEqual({ name: 'Worker' })
    expect(await requests.prompt(held().id)).toEqual({
      inputKey: 'approval',
      requestState: 'op_1',
      url: 'https://sidequest.test/approve/op_1?token=one-time',
      message: 'Approve the new agent.',
    })
  })

  it('claims one retry, takes the server waiting again, and keeps its answer', async () => {
    const { store: requests } = await store()
    const { id } = await requests.hold(held(), 1000)
    expect(requests.claim(id, 2000).changed).toBe(true)
    expect(requests.claim(id, 2000).changed).toBe(false)
    await requests.again(
      id,
      { inputKey: 'approval', requestState: 'op_2', url: 'https://sidequest.test/a', message: 'Still waiting.' },
      3000,
    )
    expect(requests.get(id).state).toBe('pending')
    expect((await requests.prompt(id)).requestState).toBe('op_2')
    expect(requests.claim(id, 4000).changed).toBe(true)
    await requests.finish(id, 'completed', { content: [{ type: 'text', text: 'created' }] }, 5000)
    expect(requests.get(id).state).toBe('completed')
    expect(await requests.result(id)).toEqual({ content: [{ type: 'text', text: 'created' }] })
  })

  it('refuses a different call under the same id, and lets the same call take the newer prompt', async () => {
    const { store: requests } = await store()
    await requests.hold(held(), 1000)
    await expect(requests.hold(held({ arguments: { name: 'Hirer' } }), 1500)).rejects.toMatchObject({
      _tag: 'Conflict',
    })
    await requests.hold(held({ requestState: 'op_9' }), 2000)
    expect((await requests.prompt(held().id)).requestState).toBe('op_9')
  })

  it('expires a request past its time instead of retrying it, and never sends an interrupted retry again', async () => {
    const { store: requests } = await store()
    const late = await requests.hold(held(), 1000)
    expect(requests.claim(late.id, 10_000)).toMatchObject({ changed: false, row: { state: 'expired' } })
    const other = await requests.hold(held({ id: urlRequestId('41', 'c2'), sourceCallId: 'c2' }), 1000)
    const waiting = await requests.hold(
      held({ id: urlRequestId('41', 'c3'), sourceCallId: 'c3', expiresAt: 3000 }),
      1000,
    )
    requests.claim(other.id, 2000)
    requests.recover(5000)
    expect(requests.get(other.id).state).toBe('uncertain')
    expect(requests.get(waiting.id).state).toBe('expired')
    requests.decline(other.id, 6000)
    expect(requests.get(other.id).state).toBe('uncertain')
  })

  it('refuses a request state over 64 KiB rather than cutting it', async () => {
    const { store: requests } = await store()
    await expect(requests.hold(held({ requestState: 'x'.repeat(65_537) }), 1000)).rejects.toMatchObject({
      _tag: 'PayloadTooLarge',
    })
  })
})
