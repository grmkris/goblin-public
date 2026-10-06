/**
 * Manual acceptance against the retained dev Worker (`smoke:dev`) or the local stack (`smoke:local`). Never imported
 * by CI or the deployed Worker. It reads the owner's state and changes one thing for the length of its agent turns:
 * with `GOBLIN_SMOKE_MODEL` set, the agent answers on that model, and the owner's own pick is put back afterwards,
 * whatever failed. Grants stay as the owner set them. Turns run in main and a side thread closed afterwards; the throwaway
 * inbound client is revoked before the script exits, and the one file it uploads is deleted again.
 */
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { appChecks } from './smoke-apps.ts'

const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof ObjectSchema.Type
const object = Schema.decodeUnknownSync(ObjectSchema)
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))
const string = Schema.decodeUnknownSync(Schema.String)
const number = Schema.decodeUnknownSync(Schema.Number)

/** A read-only tool per known server, called only if the owner has already granted it. */
const PROBES: Readonly<Record<string, string>> = { myplan: 'account_read', mybrowser: 'browser_backends' }
const REDIRECT_URI = 'http://127.0.0.1:9/callback'
const DEV_MARKER = 'GOBLIN_DEV_OK'
const MCP_MARKER = 'GOBLIN_MCP_OK'
const SMOKE_CLIENT_NAME = 'goblin-smoke'
const MAIN_HISTORY = '/api/conversations/1/history?before=2147483647'

type Step = { readonly step: string; readonly status: number }
type Settings = {
  readonly stage: string
  readonly url: string
  readonly email: Redacted.Redacted
  readonly sessionFile: string
}

const settings = Effect.gen(function* () {
  return {
    stage: yield* Config.String('GOBLIN_STAGE'),
    url: yield* Config.String('GOBLIN_APP_URL'),
    email: yield* Config.Redacted('GOBLIN_OWNER_EMAIL').pipe(Config.withDefault(Redacted.make(''))),
    sessionFile: yield* Config.String('GOBLIN_SMOKE_SESSION_FILE').pipe(Config.withDefault('')),
    /** The model the smoke's agent turns run on (dev: an Alibaba Token Plan model); unset: the owner's own pick. */
    smokeModel: Option.getOrUndefined(yield* Config.option(Config.String('GOBLIN_SMOKE_MODEL'))),
  }
})

/** Smoke follows the stage's configured APP_URL; local remains tied to the local stack. */
function targetUrl(config: Settings): URL {
  const url = new URL(config.url)
  const deployed = (config.stage === 'dev' || config.stage === 'prod') && url.protocol === 'https:'
  const local = config.stage === 'local' && url.origin === 'http://localhost:18971'
  if ((!deployed && !local) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('stage_app_origin_required')
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
      signal: rest.signal ?? AbortSignal.timeout(150_000),
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

  async useSession(file: string, email: Redacted.Redacted): Promise<void> {
    if (!file || (await stat(file)).mode & 0o077) throw new Error('private_otp_session_file_required')
    const saved = Schema.decodeUnknownSync(Schema.Struct({ origin: Schema.String, cookie: Schema.String }))(
      JSON.parse(await readFile(file, 'utf8')),
    )
    if (saved.origin !== this.origin || !saved.cookie.includes('session_token='))
      throw new Error('session_origin_mismatch')
    this.#cookie = saved.cookie
    const session = await this.json('/api/auth/get-session')
    const owner = object(session['user'])
    if (string(owner['email']) !== Redacted.value(email)) throw new Error('session_owner_mismatch')
    if (Date.parse(string(object(session['session'])['expiresAt'])) <= Date.now()) throw new Error('session_expired')
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
        client_name: SMOKE_CLIENT_NAME,
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
      scope: 'openid offline_access goblin:inspect',
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
    if (result === undefined) throw new Error(`inbound_tool_failed: ${name}`)
    const [first] = objects(result['content'])
    // A tool error is goblin's encoded error: report its tag (`BudgetExhausted`), never the rest of what it says.
    const tag = /"_tag":"(\w+)"/u.exec(string(first?.['text'] ?? ''))?.[1]
    if (result['isError'] === true) throw new Error(`inbound_tool_failed: ${name}: ${tag ?? 'unknown'}`)
    return object(JSON.parse(string(first?.['text'])))
  }

  async ask(input: string): Promise<JsonObject> {
    return this.tool('ask_agent', { input, operationId: operationId('inbound'), waitSeconds: 100 })
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
    headers: { 'content-type': 'application/json', 'x-goblin-csrf': '1' },
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

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

const operationId = (step: string): string => `smoke-${step}-${base64url(randomBytes(9))}`

async function poll(
  dev: DevClient,
  path: string,
  ready: (value: JsonObject) => boolean,
  milliseconds: number,
  reason: string,
): Promise<void> {
  const deadline = Date.now() + milliseconds
  const signal = AbortSignal.timeout(milliseconds)
  try {
    await wait(1_500)
    while (Date.now() < deadline) {
      if (ready(await dev.json(path, { signal }))) return
      await wait(1_000)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
  throw new Error(reason)
}

const waitForIdle = (dev: DevClient, thread: string): Promise<void> =>
  poll(
    dev,
    `/api/conversations/${encodeURIComponent(thread)}/snapshot`,
    (snapshot) => !snapshot['run'] && objects(snapshot['inbox']).length === 0,
    120_000,
    'thread_still_busy',
  )

async function submitMessage(dev: DevClient, thread: string, input: string, step: string): Promise<void> {
  const response = await dev.send(`/api/conversations/${encodeURIComponent(thread)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, operationId: operationId(step) }),
  })
  if (response.status !== 202) throw new Error(`${step}_submit_failed`)
}

/** Text from Pi's model messages, whether the provider returned a string or text content blocks. */
function entryText(entry: JsonObject): string {
  return objects(entry['model'] ?? [])
    .flatMap((message) => {
      const content = message['content']
      return Array.isArray(content)
        ? objects(content).flatMap((block) => (block['text'] === undefined ? [] : [string(block['text'])]))
        : [string(content)]
    })
    .join(' ')
}

type ThreadCheck = { readonly thread: 'ok'; readonly shared: true }

async function closeThread(dev: DevClient, thread: string): Promise<void> {
  const closed = await dev.send(`/api/conversations/${encodeURIComponent(thread)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ closed: true }),
  })
  if (!closed.ok) throw new Error('thread_close_failed')
}

async function threadChecks(dev: DevClient): Promise<ThreadCheck> {
  const created = await dev.json('/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const thread = string(created['id'])
  try {
    await submitMessage(
      dev,
      thread,
      'Pick three prime numbers between 10 and 30 and tell me which you picked. Short.',
      'thread',
    )
    await waitForIdle(dev, thread)
    const before = await dev.json(MAIN_HISTORY)
    const seen = new Set(objects(before['entries']).map((entry) => entry['id']))
    await submitMessage(dev, thread, 'Share what we concluded here with main.', 'thread_share')
    await poll(
      dev,
      MAIN_HISTORY,
      (history) =>
        objects(history['entries']).some((entry) => entry['kind'] === 'app.shared' && !seen.has(entry['id'])),
      60_000,
      'thread_share_missing',
    )
    await waitForIdle(dev, thread)
    return { thread: 'ok', shared: true }
  } finally {
    await closeThread(dev, thread)
  }
}

type SubagentCheck = { readonly subagent: 'reported' }

async function subagentChecks(dev: DevClient): Promise<SubagentCheck> {
  const before = await dev.json(MAIN_HISTORY)
  const seen = new Set(objects(before['entries']).map((entry) => entry['id']))
  await submitMessage(
    dev,
    '1',
    'Start a subagent named smokecount: it should count the letters in the word "goblin" and report the number. Then tell me you started it.',
    'subagent',
  )
  await poll(
    dev,
    MAIN_HISTORY,
    (history) => {
      const entries = objects(history['entries']).filter((entry) => !seen.has(entry['id']))
      const reportIndex = entries.findIndex(
        (entry) => entry['kind'] === 'pi.user' && entryText(entry).includes('[from subagent smokecount]'),
      )
      return (
        reportIndex >= 0 &&
        entries
          .slice(reportIndex + 1)
          .some((entry) => entry['kind'] === 'pi.assistant' && entryText(entry).trim() !== '')
      )
    },
    120_000,
    'subagent_report_missing',
  )
  await waitForIdle(dev, '1')
  return { subagent: 'reported' }
}

type MemoryCheck = { readonly memory: { readonly messages: number; readonly summarized: number } }

async function memoryChecks(dev: DevClient): Promise<MemoryCheck> {
  const memory = await dev.json('/api/agent/memory')
  const messages = number(memory['messages'])
  const summarized = number(memory['summarized'])
  if (messages === 0) throw new Error('memory_empty')
  return { memory: { messages, summarized } }
}

async function inboundChecks(dev: DevClient, client: InboundClient, servers: readonly ServerReport[]) {
  await client.authorize()
  const init = await client.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: SMOKE_CLIENT_NAME, version: '1' },
  })
  const listed = await client.rpc('tools/list')
  const names = objects(listed.result?.['tools'] ?? []).map((tool) => tool['name'])
  if (init.result === undefined || !names.includes('ask_agent') || !names.includes('get_recent_messages'))
    throw new Error('inbound_tools_missing')
  // Consent granted `goblin:inspect`, so the same /mcp offers read-only inspection (ADR 0024). It reads without a model.
  const inspection = names.filter((name) => typeof name === 'string' && name.startsWith('inspect_'))
  const problems = inspection.length === 5 ? await client.tool('inspect_problems', {}) : {}
  if (!Array.isArray(problems['problems'])) throw new Error('inbound_inspection_missing')
  const smokeInput = `Reply with exactly: ${DEV_MARKER}`
  const reply = await client.ask(smokeInput)
  if (reply['status'] !== 'done' || reply['text'] !== DEV_MARKER) throw new Error('inbound_model_turn_failed')
  const residentTool = await residentToolTurn(client, servers)
  const recent = await client.tool('get_recent_messages', { limit: 10 })
  const messages = objects(recent['messages'])
  const texts = messages.map((message) => message['text'])
  if (!texts.includes(DEV_MARKER)) throw new Error('inbound_history_missing')
  const smokeMessage = messages.findLast((message) => message['role'] === 'user' && message['text'] === smokeInput)
  if (smokeMessage?.['author'] !== SMOKE_CLIENT_NAME) throw new Error('inbound_author_missing')
  const revoked = await dev.json(`/api/clients/${encodeURIComponent(client.clientId)}`, { method: 'DELETE' })
  const after = await client.rpc('tools/list')
  if (revoked['revoked'] !== true || after.status !== 401) throw new Error('inbound_revocation_failed')
  return { initialized: true, modelTurn: 'ok', residentTool, history: 'ok', author: 'ok', revokedThen401: true }
}

const putModel = (dev: DevClient, model: string) =>
  dev.json('/api/agent/model', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  })

/** Runs `work` with the agent answering on `model`, then puts the owner's own pick back, whatever happened. */
async function withModel<T>(dev: DevClient, model: string | undefined, work: () => Promise<T>): Promise<T> {
  if (model === undefined) return work()
  const choice = await dev.json('/api/agent/model')
  if (!objects(choice['options']).some((option) => option['id'] === model)) throw new Error('smoke_model_not_offered')
  const own = string(choice['current'])
  if (own === model) return work()
  await putModel(dev, model)
  try {
    return await work()
  } finally {
    await putModel(dev, own)
  }
}

type FileCheck = { readonly files: 'ok' }

/** Why a file that was just uploaded does not read back as it was, or nothing. */
async function fileReadBack(dev: DevClient, path: string, target: string, body: string): Promise<string | undefined> {
  const listing = await dev.json('/api/files?dir=%2Fuploads')
  if (!objects(listing['entries']).some((entry) => entry['path'] === path)) return 'file_not_listed'
  const read = await dev.send(target)
  return read.ok && (await read.text()) === body ? undefined : 'file_read_mismatch'
}

/** The owner's files (ADR 0022): a small text file uploads, lists, downloads byte for byte and is deleted. */
async function fileChecks(dev: DevClient): Promise<FileCheck> {
  const path = `/uploads/smoke-${base64url(randomBytes(6))}.txt`
  const target = `/api/files/content?path=${encodeURIComponent(path)}`
  const body = `goblin smoke ${new Date().toISOString()}\n`
  const csrf = { 'x-goblin-csrf': '1' }
  const put = await dev.send(target, { method: 'PUT', headers: { ...csrf, 'content-type': 'text/plain' }, body })
  if (put.status !== 201) throw new Error('file_upload_failed')
  const failure = await fileReadBack(dev, path, target, body).catch(() => 'file_read_failed')
  // Delete it whatever the read found, then report.
  const deleted = await dev.send(target, { method: 'DELETE', headers: csrf })
  if (failure !== undefined) throw new Error(failure)
  if (!deleted.ok) throw new Error('file_delete_failed')
  return { files: 'ok' }
}

/** Unless sign-up is open, a registration without the invite code must be refused (and so writes nothing). */
async function refusedSignup(dev: DevClient, steps: Step[]): Promise<void> {
  const response = await dev.send('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    owner: false,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `smoke-${base64url(randomBytes(6)).toLowerCase()}@example.invalid`,
      type: 'sign-in',
    }),
  })
  if (response.status === 429) {
    steps.push({ step: 'signup refused (rate-limited); gate not proven open', status: response.status })
    return
  }
  if (response.status !== 403) throw new Error('signup_gate_open')
}

type Receipt = {
  readonly stage: string
  readonly model: string
  readonly signup: string
  readonly resident: string
  readonly servers: readonly ServerReport[]
  readonly inbound: Awaited<ReturnType<typeof inboundChecks>>
  readonly thread: ThreadCheck['thread']
  readonly shared: ThreadCheck['shared']
  readonly subagent: SubagentCheck['subagent']
  readonly memory: MemoryCheck['memory']
  readonly files: FileCheck['files']
  readonly app: 'ok'
}

async function smokeDev(
  steps: Step[],
): Promise<Receipt | { readonly stage: string; readonly signup: string; readonly mode: 'read-only' }> {
  const config = await Effect.runPromise(settings)
  if ((await stat(new URL(`../.local/${config.stage}.env`, import.meta.url))).mode & 0o077)
    throw new Error('private_stage_env_required')
  const dev = new DevClient(targetUrl(config), steps)
  const health = await dev.json('/health', { owner: false })
  if (health['stage'] !== config.stage || health['service'] !== 'goblin') throw new Error('stage_health_mismatch')
  const signup = string(health['signup'])
  if (config.stage === 'prod' && (Redacted.value(config.email) === '' || config.sessionFile === '')) {
    const probe = await dev.send('/api/conversations', { owner: false })
    if (probe.status !== 401) throw new Error('anonymous_auth_probe_not_refused')
    return { stage: config.stage, signup, mode: 'read-only' }
  }
  if (signup !== 'open') await refusedSignup(dev, steps)
  await dev.useSession(config.sessionFile, config.email)
  const resident = await dev.json('/api/agent/resident')
  if (resident['state'] !== 'active') throw new Error('resident_authority_inactive')
  const snapshot = await dev.json('/api/conversations/1/snapshot')
  if (snapshot['type'] !== 'snapshot') throw new Error('main_snapshot_missing')
  const { files } = await fileChecks(dev)
  const servers: ServerReport[] = []
  for (const server of await dev.list('/api/mcp/servers')) servers.push(await serverReport(dev, server))
  const client = await InboundClient.register(dev)
  try {
    const checks = await withModel(dev, config.smokeModel, async () => {
      const inbound = await inboundChecks(dev, client, servers)
      const thread = await threadChecks(dev)
      const subagent = await subagentChecks(dev)
      const memory = await memoryChecks(dev)
      const app = await appChecks(dev, { submit: submitMessage, idle: waitForIdle, close: closeThread })
      return { inbound, ...thread, ...subagent, ...memory, ...app }
    })
    const model = config.smokeModel ?? 'owner pick'
    return { stage: config.stage, model, signup, resident: string(resident['state']), servers, files, ...checks }
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
