/** Manual retained-dev acceptance only. Never imported by CI or the deployed Worker. */
import { Clock, Config, Effect, Redacted, Schema } from 'effect'
import { chmod, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
const object = Schema.decodeUnknownSync(ObjectSchema)
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))
const string = Schema.decodeUnknownSync(Schema.String)
const snapshot = Schema.decodeUnknownSync(
  Schema.Struct({ type: Schema.Literal('snapshot'), entries: Schema.Array(ObjectSchema) }),
)
type JsonObject = typeof ObjectSchema.Type
type Requester = (path: string, body?: JsonObject) => Promise<JsonObject>
type Credentials = { readonly email: Redacted.Redacted; readonly password: Redacted.Redacted }
type Status = { readonly step: string; readonly status: number }
const targets = [
  { serverId: 'myplan', endpoint: 'https://dev-new.myplan.lol/mcp', name: 'myplan_open' },
  { serverId: 'mybrowser', endpoint: 'https://dev.mytab.lol/mcp', name: 'browser_backends' },
] as const
const settings = Effect.gen(function* () {
  return {
    stage: yield* Config.String('PURRABLE_STAGE'),
    url: yield* Config.String('PURRABLE_APP_URL'),
    email: yield* Config.Redacted('PURRABLE_OWNER_EMAIL'),
    password: yield* Config.Redacted('PURRABLE_OWNER_PASSWORD'),
  }
})
function devUrl(config: { readonly stage: string; readonly url: string }): URL {
  const url = new URL(config.url)
  const validHost = /^purrable-dev\.[a-z0-9-]+\.workers\.dev$/u.test(url.hostname)
  if (
    config.stage !== 'dev' ||
    url.protocol !== 'https:' ||
    !validHost ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('dev_target_required')
  return url
}
function makeRequester(url: URL, statuses: Status[]): Requester {
  let cookie = ''
  return async (path, body) => {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(180_000),
      headers: { origin: url.origin, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    statuses.push({ step: path.split('?')[0] ?? path, status: response.status })
    if (!response.ok) throw new Error('dev_request_failed')
    if (path === '/api/auth/sign-in/email') {
      cookie = response.headers
        .getSetCookie()
        .flatMap((value) => {
          const pair = value.split(';')[0]
          return pair?.includes('session_token=') ? [pair] : []
        })
        .join('; ')
      if (!cookie) throw new Error('owner_session_missing')
    }
    const data: unknown = await response.json()
    return object(data)
  }
}
async function authenticate(request: Requester, config: Credentials): Promise<JsonObject> {
  if ((await stat(new URL('../.local/dev.env', import.meta.url))).mode & 0o077)
    throw new Error('private_dev_env_required')
  if (!Redacted.value(config.email) || Redacted.value(config.password).length < 12)
    throw new Error('provisioned_owner_credentials_required')
  const health = await request('/health')
  if (health['stage'] !== 'dev' || health['service'] !== 'purrable') throw new Error('dev_health_required')
  await request('/api/auth/sign-in/email', {
    email: Redacted.value(config.email),
    password: Redacted.value(config.password),
  })
  return request('/api/agent/snapshot')
}
async function discoverTargets(request: Requester, servers: readonly JsonObject[], expiresAt: number) {
  const discovery: Array<{
    serverId: string
    version: string
    capabilities: string[]
    toolCount: number
    readOk: boolean
  }> = []
  for (const target of targets) {
    const configured = servers.some(
      (server) => server['serverId'] === target.serverId && server['endpoint'] === target.endpoint,
    )
    if (!configured) throw new Error('dev_mcp_target_required')
    await request('/api/mcp/grants', {
      clientId: 'owner-session',
      serverId: target.serverId,
      capability: 'tool',
      name: target.name,
      scopes: [],
      expiresAt,
    })
    const connected = await request(`/api/mcp/${target.serverId}/connect`, {})
    const result = await request(`/api/mcp/${target.serverId}/tools/call`, { name: target.name, arguments: {} })
    if (result['isError'] === true) throw new Error('dev_mcp_read_failed')
    discovery.push({
      serverId: target.serverId,
      version: string(connected['protocolVersion']),
      capabilities: Object.keys(object(connected['capabilities'])).filter((name) =>
        ['tools', 'resources', 'prompts'].includes(name),
      ),
      toolCount: objects(connected['tools']).length,
      readOk: true,
    })
  }
  return discovery
}
async function submitAndVerify(request: Requester, before: ReturnType<typeof snapshot>) {
  const operationId = randomUUID()
  const accepted = await request('/api/agent', {
    operationId,
    input:
      'Call mcp_call exactly once with serverId "myplan", name "myplan_open", arguments {}. Do not call any other tool. After a successful result, reply with exactly PURRABLE_MCP_OK. If it fails, report failure without the marker.',
  })
  if (accepted['operationId'] !== operationId || accepted['accepted'] !== true) throw new Error('pi_acceptance_failed')
  const settled = await request(`/api/agent/wait?operationId=${encodeURIComponent(operationId)}`)
  const committed = snapshot(await request('/api/agent/snapshot'))
  const oldEntries = new Set(before.entries.map((entry) => JSON.stringify(entry['id'])))
  const entries = committed.entries.filter((entry) => !oldEntries.has(JSON.stringify(entry['id'])))
  const proof = committedProof(entries)
  if (settled['status'] !== 'done' || !proof.toolResult || !proof.assistantMarker)
    throw new Error('pi_mcp_completion_failed')
  return { operationId, proof, entries }
}
function assistantBlocks(entries: readonly JsonObject[]): JsonObject[] {
  return entries.flatMap((entry) =>
    objects(entry['model'] ?? []).flatMap((message) =>
      message['role'] === 'assistant' ? objects(message['content']) : [],
    ),
  )
}
function matchingCall(block: JsonObject): boolean {
  if (block['type'] !== 'toolCall' || block['name'] !== 'mcp_call') return false
  const args = object(block['arguments'])
  return (
    args['serverId'] === 'myplan' &&
    args['name'] === 'myplan_open' &&
    Object.keys(object(args['arguments'])).length === 0
  )
}
function committedProof(entries: readonly JsonObject[]) {
  const blocks = assistantBlocks(entries)
  const calls = new Set(blocks.flatMap((block) => (matchingCall(block) ? [string(block['id'])] : [])))
  const toolResult = entries.some(
    (entry) =>
      entry['kind'] === 'pi.tool-result' &&
      objects(entry['model'] ?? []).some(
        (message) =>
          message['role'] === 'toolResult' &&
          message['toolName'] === 'mcp_call' &&
          message['isError'] === false &&
          calls.has(string(message['toolCallId'])),
      ),
  )
  const assistantMarker = blocks.some((block) => block['type'] === 'text' && block['text'] === 'PURRABLE_MCP_OK')
  return { assistantToolCall: calls.size === 1, toolResult: calls.size === 1 && toolResult, assistantMarker }
}
async function smokeDev(statuses: Status[]): Promise<void> {
  const config = await Effect.runPromise(settings)
  const request = makeRequester(devUrl(config), statuses)
  const before = snapshot(await authenticate(request, config))
  const servers = objects((await request('/api/mcp/servers'))['servers'])
  const expiresAt = Math.floor((await Effect.runPromise(Clock.currentTimeMillis)) / 1000) + 3600
  const discovery = await discoverTargets(request, servers, expiresAt)
  const { operationId, proof, entries } = await submitAndVerify(request, before)
  const receipt = {
    environment: 'dev deployment',
    utc: new Date(await Effect.runPromise(Clock.currentTimeMillis)).toISOString(),
    operationId,
    status: 'done',
    statuses,
    discovery,
    accepted: true,
    ...proof,
    transcriptHash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  }
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  const receiptPath = new URL('../.local/smoke-dev-receipt.json', import.meta.url)
  await writeFile(receiptPath, output, { mode: 0o600 })
  await chmod(receiptPath, 0o600)
  console.info(output)
}
const statuses: Status[] = []
try {
  await smokeDev(statuses)
} catch {
  console.error(JSON.stringify({ environment: 'dev deployment', status: 'failed', receiptVerified: false, statuses }))
  process.exitCode = 1
}
