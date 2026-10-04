/**
 * Manual acceptance against the retained dev Worker (`smoke:dev`) or the local stack (`smoke:local`). Never imported
 * by CI or the deployed Worker. It reads the owner's state but changes none
 * of it: grants stay as the owner set them, and agent turns run in a throwaway inbound client's own conversation,
 * which is revoked before the script exits.
 */
import { Config, Effect, Redacted, Schema } from 'effect'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, stat, writeFile } from 'node:fs/promises'

const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof ObjectSchema.Type
const object = Schema.decodeUnknownSync(ObjectSchema)
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))
const string = Schema.decodeUnknownSync(Schema.String)

/** A read-only tool per known server, called only if the owner has already granted it. */
const PROBES: Readonly<Record<string, string>> = { myplan: 'account_read', mybrowser: 'browser_backends' }
const REDIRECT_URI = 'http://127.0.0.1:9/callback'
const DEV_MARKER = 'PURRABLE_DEV_OK'
const MCP_MARKER = 'PURRABLE_MCP_OK'

type Step = { readonly step: string; readonly status: number }
type Settings = {
  readonly stage: string
  readonly url: string
  readonly email: Redacted.Redacted
  readonly password: Redacted.Redacted
}

const settings = Effect.gen(function* () {
  return {
    stage: yield* Config.String('PURRABLE_STAGE'),
    url: yield* Config.String('PURRABLE_APP_URL'),
    email: yield* Config.Redacted('PURRABLE_OWNER_EMAIL'),
    password: yield* Config.Redacted('PURRABLE_OWNER_PASSWORD'),
  }
})

/** Only the retained dev Worker or the local `bun dev` stack; anything else is refused. */
function targetUrl(config: Settings): URL {
  const url = new URL(config.url)
  const dev =
    config.stage === 'dev' &&
    url.protocol === 'https:' &&
    /^purrable-dev\.[a-z0-9-]+\.workers\.dev$/u.test(url.hostname)
  const local = config.stage === 'local' && url.origin === 'http://localhost:18971'
  if ((!dev && !local) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('dev_or_local_target_required')
  return url
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url')

/** Everything the smoke sends goes through here: one origin, the owner cookie when signed in, every status logged. */
class DevClient {
  readonly #url: URL
  readonly #steps: Step[]
  #cookie = ''
  constructor(url: URL, steps: Step[]) {
    this.#url = url
    this.#steps = steps
  }

  get origin(): string {
    return this.#url.origin
  }

  async send(path: string, init: RequestInit & { readonly owner?: boolean } = {}): Promise<Response> {
    const { owner = true, ...rest } = init
    const headers = new Headers(rest.headers)
    headers.set('origin', this.#url.origin)
    if (owner && this.#cookie) headers.set('cookie', this.#cookie)
    const response = await fetch(new URL(path, this.#url), {
      ...rest,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(150_000),
    })
    this.#steps.push({ step: `${rest.method ?? 'GET'} ${path.split('?')[0] ?? path}`, status: response.status })
    return response
  }

  async json(path: string, init: RequestInit & { readonly owner?: boolean } = {}): Promise<JsonObject> {
    const response = await this.send(path, init)
    if (!response.ok) throw new Error(`request_failed: ${path.split('?')[0] ?? path}`)
    return object(await response.json())
  }

  async list(path: string): Promise<readonly JsonObject[]> {
    const response = await this.send(path)
    if (!response.ok) throw new Error(`request_failed: ${path}`)
    return objects(await response.json())
  }

  async signIn(email: Redacted.Redacted, password: Redacted.Redacted): Promise<void> {
    const response = await this.send('/api/auth/sign-in/email', {
      method: 'POST',
      owner: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: Redacted.value(email), password: Redacted.value(password) }),
    })
    if (!response.ok) throw new Error('owner_sign_in_failed')
    this.#cookie = response.headers
      .getSetCookie()
      .flatMap((value) => {
        const pair = value.split(';')[0]
        return pair?.includes('session_token=') ? [pair] : []
      })
      .join('; ')
    if (!this.#cookie) throw new Error('owner_session_missing')
  }
}

/** An inbound MCP client: dynamic registration, owner consent, PKCE code exchange, then Streamable HTTP calls. */
class InboundClient {
  readonly #dev: DevClient
  readonly clientId: string
  #token = ''
  #nextId = 1
  constructor(dev: DevClient, clientId: string) {
    this.#dev = dev
    this.clientId = clientId
  }

  static async register(dev: DevClient): Promise<InboundClient> {
    const registered = await dev.json('/api/auth/oauth2/register', {
      method: 'POST',
      owner: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'purrable-smoke',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
    return new InboundClient(dev, string(registered['client_id']))
  }

  async authorize(): Promise<void> {
    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const resource = `${this.#dev.origin}/mcp`
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid offline_access',
      state: base64url(randomBytes(16)),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
    })
    const authorize = await this.#dev.send(`/api/auth/oauth2/authorize?${query.toString()}`)
    const location = authorize.headers.get('location') ?? ''
    if (!location.startsWith('/consent?')) throw new Error('consent_redirect_missing')
    const consent = await this.#dev.json('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: location.slice('/consent?'.length) }),
    })
    const code = new URL(string(consent['url'])).searchParams.get('code')
    if (code === null) throw new Error('authorization_code_missing')
    const token = await this.#dev.json('/api/auth/oauth2/token', {
      method: 'POST',
      owner: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        resource,
      }).toString(),
    })
    this.#token = string(token['access_token'])
  }

  /** One JSON-RPC call; the stateless server answers with JSON or a one-event SSE stream. */
  async rpc(method: string, params: JsonObject = {}): Promise<{ status: number; result?: JsonObject }> {
    const response = await this.#dev.send('/mcp', {
      method: 'POST',
      owner: false,
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
    })
    if (!response.ok) return { status: response.status }
    const body = await response.text()
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? (body
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .at(-1)
          ?.slice('data: '.length) ?? '{}')
      : body
    const message = object(JSON.parse(payload))
    if (message['error'] !== undefined) throw new Error(`mcp_rpc_error: ${method}`)
    return { status: response.status, result: object(message['result']) }
  }

  async tool(name: string, args: JsonObject): Promise<JsonObject> {
    const { result } = await this.rpc('tools/call', { name, arguments: args })
    if (result === undefined || result['isError'] === true) throw new Error(`inbound_tool_failed: ${name}`)
    const [first] = objects(result['content'])
    return object(JSON.parse(string(first?.['text'])))
  }

  async ask(input: string): Promise<JsonObject> {
    return this.tool('ask_agent', { input, operationId: `smoke-${base64url(randomBytes(9))}`, waitSeconds: 100 })
  }
}

type ServerReport = { serverId: string; status: string; tools?: number; granted?: number; probe?: string }

async function serverReport(dev: DevClient, server: JsonObject): Promise<ServerReport> {
  const serverId = string(server['serverId'])
  const report: ServerReport = { serverId, status: string(server['status']) }
  if (report.status !== 'connected') return report
  const tools = await dev.list(`/api/mcp/${encodeURIComponent(serverId)}/tools?refresh`)
  report.tools = tools.length
  report.granted = tools.filter((tool) => tool['granted'] === true).length
  const probe = PROBES[serverId]
  const granted = tools.some((tool) => tool['name'] === probe && tool['granted'] === true)
  if (probe === undefined || !granted) {
    report.probe = 'not-granted'
    return report
  }
  const result = await dev.json(`/api/mcp/${encodeURIComponent(serverId)}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: probe, arguments: {} }),
  })
  report.probe = result['isError'] === true ? 'error' : 'ok'
  return report
}

/** If the owner has granted the MyPlan probe, the agent must be able to call it through its resident authority. */
async function residentToolTurn(client: InboundClient, servers: readonly ServerReport[]): Promise<'ok' | 'skipped'> {
  if (!servers.some((server) => server.serverId === 'myplan' && server.probe === 'ok')) return 'skipped'
  const used = await client.ask(
    `Call mcp_call exactly once with serverId "myplan", name "${PROBES['myplan'] ?? ''}" and arguments {}. ` +
      `After a successful result reply with exactly ${MCP_MARKER}; otherwise describe the failure.`,
  )
  if (used['status'] !== 'done' || used['text'] !== MCP_MARKER) throw new Error('resident_tool_turn_failed')
  return 'ok'
}

async function inboundChecks(dev: DevClient, client: InboundClient, servers: readonly ServerReport[]) {
  await client.authorize()
  const init = await client.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'purrable-smoke', version: '1' },
  })
  const listed = await client.rpc('tools/list')
  const names = objects(listed.result?.['tools'] ?? []).map((tool) => tool['name'])
  if (init.result === undefined || !names.includes('ask_agent') || !names.includes('get_recent_messages'))
    throw new Error('inbound_tools_missing')
  const reply = await client.ask(`Reply with exactly: ${DEV_MARKER}`)
  if (reply['status'] !== 'done' || reply['text'] !== DEV_MARKER) throw new Error('inbound_model_turn_failed')
  const residentTool = await residentToolTurn(client, servers)
  const recent = await client.tool('get_recent_messages', { limit: 10 })
  const texts = objects(recent['messages']).map((message) => message['text'])
  if (!texts.includes(DEV_MARKER)) throw new Error('inbound_history_missing')
  const revoked = await dev.json(`/api/clients/${encodeURIComponent(client.clientId)}`, { method: 'DELETE' })
  const after = await client.rpc('tools/list')
  if (revoked['revoked'] !== true || after.status !== 401) throw new Error('inbound_revocation_failed')
  return { initialized: true, modelTurn: 'ok', residentTool, history: 'ok', revokedThen401: true }
}

type Receipt = {
  readonly stage: string
  readonly resident: string
  readonly servers: readonly ServerReport[]
  readonly inbound: Awaited<ReturnType<typeof inboundChecks>>
}

async function smokeDev(steps: Step[]): Promise<Receipt> {
  const config = await Effect.runPromise(settings)
  if ((await stat(new URL(`../.local/${config.stage}.env`, import.meta.url))).mode & 0o077)
    throw new Error('private_stage_env_required')
  const dev = new DevClient(targetUrl(config), steps)
  const health = await dev.json('/health', { owner: false })
  if (health['stage'] !== config.stage || health['service'] !== 'purrable') throw new Error('stage_health_mismatch')
  await dev.signIn(config.email, config.password)
  const resident = await dev.json('/api/agent/resident')
  if (resident['state'] !== 'active') throw new Error('resident_authority_inactive')
  const snapshot = await dev.json('/api/agent/snapshot')
  if (snapshot['type'] !== 'snapshot') throw new Error('main_snapshot_missing')
  const servers: ServerReport[] = []
  for (const server of await dev.list('/api/mcp/servers')) servers.push(await serverReport(dev, server))
  const client = await InboundClient.register(dev)
  try {
    const inbound = await inboundChecks(dev, client, servers)
    return { stage: config.stage, resident: string(resident['state']), servers, inbound }
  } finally {
    // Never leave the throwaway client authorized, whatever failed above.
    await dev.send(`/api/clients/${encodeURIComponent(client.clientId)}`, { method: 'DELETE' })
  }
}

const steps: Step[] = []
try {
  const result = await smokeDev(steps)
  const receipt = { utc: new Date().toISOString(), status: 'passed', ...result, steps }
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  const receiptPath = new URL(`../.local/smoke-${result.stage}-receipt.json`, import.meta.url)
  await writeFile(receiptPath, output, { mode: 0o600 })
  await chmod(receiptPath, 0o600)
  console.info(output)
} catch (error) {
  const reason = error instanceof Error ? error.message : 'unknown'
  console.error(JSON.stringify({ status: 'failed', reason, steps }, null, 2))
  process.exitCode = 1
}
