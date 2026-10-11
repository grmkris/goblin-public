import { createMcpHandler, ProtocolError } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import * as Option from 'effect/Option'
import { sign } from '../../src/mcp/events/webhook.ts'
import { EVENTS_EXTENSION, type EventEnvelope } from '../../src/mcp/events/protocol.ts'
import { SKILLS_EXTENSION, type SkillEntry } from '../../src/skills/protocol.ts'
import { lowLevelServer } from './low-level-server.ts'

const Params = Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown))
const Subscribe = Schema.Struct({
  name: Schema.String,
  delivery: Schema.Struct({ mode: Schema.Literal('webhook'), url: Schema.String, secret: Schema.String }),
})

/**
 * A producer of the draft Events profile. It declares Events as top-level `capabilities.events`, or with `spelling`
 * `extension` as the SEP-3415 `io.modelcontextprotocol/events` extension; `payloadSchema` may be left out.
 */
export class EventsFixture {
  readonly subscriptions = new Map<string, { secret: string; url: string }>()
  readonly journal: { eventId: string; name: string; timestamp: string; data: unknown; cursor: string }[] = []
  readonly calls: string[] = []
  readonly inbox: { id: string; text: string; direction: string }[] = []
  skills: readonly SkillEntry[] = []
  readonly files = new Map<string, string>()
  inputSchema: Record<string, unknown> = { type: 'object' }
  payloadSchema: Record<string, unknown> | undefined = { type: 'object' }
  spelling: 'top-level' | 'extension' = 'top-level'
  cursor = '0'
  now = Date.now()
  ttlMs = 3_600_000
  receiver: ((request: Request) => Promise<Response>) | undefined
  readonly #handler = createMcpHandler(() => {
    const server = lowLevelServer(
      { name: 'mygram-events-fixture', version: '1' },
      { capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION]: {} } } },
    )
    server.setRequestHandler('skills/list', { params: Params }, () => ({ skills: this.skills, ttlMs: 60_000 }))
    server.setRequestHandler('resources/list', () => ({ resources: [] }))
    server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }))
    server.setRequestHandler('resources/read', (request) => ({
      contents: [
        { uri: request.params.uri, text: this.files.get(request.params.uri) ?? '', mimeType: 'text/markdown' },
      ],
    }))
    server.setRequestHandler('tools/list', () => ({
      tools: ['inbox', 'send_message', 'subscribe', 'unsubscribe'].map((name) => ({
        name,
        inputSchema: { type: 'object' as const },
      })),
    }))
    server.setRequestHandler('tools/call', (request) => {
      this.calls.push(request.params.name)
      const content =
        request.params.name === 'inbox'
          ? { messages: request.params.arguments?.cursor === this.cursor ? [] : this.inbox, nextCursor: this.cursor }
          : { status: 'subscribed' }
      return { content: [], structuredContent: content }
    })
    server.setRequestHandler('events/list', { params: Params }, () => ({
      resultType: 'complete',
      events: ['message.received', 'question.answered', 'skills.updated', 'skills.list_changed'].map((name) => ({
        name,
        description: name,
        inputSchema: this.inputSchema,
        ...(this.payloadSchema === undefined ? {} : { payloadSchema: this.payloadSchema }),
        delivery: ['poll', 'webhook'],
      })),
    }))
    server.setRequestHandler('events/subscribe', { params: Params }, async (params) => {
      this.calls.push('events/subscribe')
      const request = Schema.decodeUnknownSync(Subscribe)(params)
      const id = this.#idFor(request.name, request.delivery.url)
      this.subscriptions.set(id, request.delivery)
      if (this.receiver !== undefined) {
        const response = await this.deliver(
          id,
          { type: 'verification', challenge: 'fixture-challenge' },
          `msg_verification_${this.calls.length}`,
        )
        if (response.status !== 200 || (await response.text()) !== '{"challenge":"fixture-challenge"}')
          throw new ProtocolError(-32015, 'challenge_failed')
      }
      return {
        resultType: 'complete',
        id,
        refreshBefore: new Date(this.now + this.ttlMs).toISOString(),
        cursor: this.cursor,
        truncated: false,
      }
    })
    server.setRequestHandler('events/unsubscribe', { params: Params }, (params) => {
      this.calls.push('events/unsubscribe')
      const delivery = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }))(params['delivery'])
      const url = Option.getOrUndefined(delivery)?.url ?? ''
      if (!this.subscriptions.delete(this.#idFor(String(params['name']), url)))
        throw new ProtocolError(-32011, 'not found')
      return { resultType: 'complete' }
    })
    server.setRequestHandler('events/poll', { params: Params }, (params) => {
      this.calls.push('events/poll')
      const events = this.journal
        .filter(
          (e) =>
            e.name === params['name'] &&
            e.cursor > (Schema.decodeUnknownSync(Schema.NullOr(Schema.String))(params['cursor'] ?? null) ?? ''),
        )
        .slice(0, Number(params['maxEvents'] ?? 100))
      return {
        resultType: 'complete',
        events,
        cursor: this.cursor,
        truncated: false,
        hasMore: false,
        nextPollMs: 300_000,
      }
    })
    server.setRequestHandler('events/stream', { params: Params }, () => {
      throw new ProtocolError(-32014, 'Unsupported')
    })
    return server
  })
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const response = await this.#handler.fetch(request)
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response
    const payload: unknown = await response.clone().json()
    const Fields = Schema.Record(Schema.String, Schema.Unknown)
    const answer = Schema.decodeUnknownOption(Schema.Struct({ result: Fields }))(payload)
    const result = Option.getOrUndefined(answer)?.result
    const capabilities = Option.getOrUndefined(Schema.decodeUnknownOption(Fields)(result?.['capabilities']))
    if (result === undefined || capabilities === undefined) return response
    const extensions = Option.getOrElse(Schema.decodeUnknownOption(Fields)(capabilities['extensions']), () => ({}))
    const declared =
      this.spelling === 'top-level'
        ? { ...capabilities, events: {} }
        : { ...capabilities, extensions: { ...extensions, [EVENTS_EXTENSION]: {} } }
    return Response.json({
      ...Schema.decodeUnknownSync(Fields)(payload),
      result: { ...result, capabilities: declared },
    })
  }
  /**
   * A subscription's id, one per event name and webhook URL as a producer keyed by (name, arguments, URL) hands them
   * out: `sub_<name>` for the first URL, `sub_<name>~2`, `~3`… for the next ones (ADR 0041, two connections to one
   * server).
   */
  #idFor(name: string, url: string): string {
    const ids = [...this.subscriptions.keys()].filter((key) => key === `sub_${name}` || key.startsWith(`sub_${name}~`))
    const same = ids.find((key) => this.subscriptions.get(key)?.url === url)
    if (same !== undefined) return same
    return ids.length === 0 ? `sub_${name}` : `sub_${name}~${String(ids.length + 1)}`
  }

  async deliver(
    subscriptionId: string,
    envelope: EventEnvelope,
    id: string,
    overrides: { signature?: string; timestamp?: string } = {},
  ): Promise<Response> {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription === undefined || this.receiver === undefined) throw new Error('fixture subscription missing')
    const body = JSON.stringify(envelope)
    const timestamp = overrides.timestamp ?? String(Math.floor(this.now / 1000))
    return this.receiver(
      new Request(subscription.url, {
        method: 'POST',
        body,
        headers: {
          'x-mcp-subscription-id': subscriptionId,
          'webhook-id': id,
          'webhook-timestamp': timestamp,
          'webhook-signature':
            overrides.signature ?? (await sign(subscription.secret, id, timestamp, new TextEncoder().encode(body))),
        },
      }),
    )
  }
}
