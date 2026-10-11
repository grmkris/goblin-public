import type { ReadResourceResult, RequestOptions } from '@modelcontextprotocol/client'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { type AppError, Conflict, Forbidden, GrantDenied, NotFound, UpstreamMcp } from '../http/errors.ts'
import { type SkillEntry, skillsListStandard } from '../skills/protocol.ts'
import { timed } from './log.ts'
import {
  type Connection,
  type Manager,
  type McpManager,
  authorized,
  connectionOf,
  fits,
  lifecycle,
  managerState,
  remote,
  serverOf,
} from './connections.ts'
import { offersEvents, offersSkills, toolOffered } from './remote.ts'
import type { EventMethod } from './service.ts'
import type { McpCallOptions, McpManagerOptions, SkillRequestOptions } from './types.ts'

// The connection manager: its connections (mcp/connections.ts) and the requests it sends over them, tool calls,
// resources, draft Events and the Skills extension. Each request checks the owner's grant and the caller's authority
// again right before it is dispatched.

/** One tool call as its checks see it: the server, the tool and the arguments, serialized once. */
type ToolCall = { readonly connectionId: string; readonly name: string; readonly argumentsJson: string }

/** The checks of one tool call: before it connects and again before each of its HTTP dispatches. */
const toolGuards = (
  manager: Manager,
  { connectionId, name, argumentsJson }: ToolCall,
  { caller = 'model', authorize, approvalId, approvalContext }: McpCallOptions,
) => {
  // SAFETY: the arguments were serialized once by the caller, so this JSON object is the immutable dispatch input.
  const frozen = () => JSON.parse(argumentsJson) as Record<string, unknown>
  const granted = Effect.suspend(() =>
    manager.options.allows({ connectionId, capability: 'tool', name })
      ? Effect.void
      : Effect.fail(new GrantDenied({ connectionId, name })),
  )
  const guard = (dispatching: boolean) =>
    Effect.gen(function* () {
      if (authorize !== undefined) yield* authorize
      yield* granted
      const decide = manager.options.authorizeTool
      if (decide === undefined) return
      const { endpoint } = yield* serverOf(manager, connectionId)
      const context = approvalContext === undefined ? {} : { approvalContext }
      const dispatched = { connectionId, name, arguments: frozen(), caller, endpoint, ...context }
      yield* decide(dispatched, approvalId, dispatching, authorize)
    })
  let sent = false
  const dispatch = Effect.gen(function* () {
    if (approvalId !== undefined && sent)
      return yield* new Conflict({ reason: 'Approved MCP dispatch cannot be retried' })
    yield* guard(true)
    sent = true
    yield* granted
  })
  return { frozen, granted, guard, dispatch }
}

const callTool = (manager: Manager, call: ToolCall, args: Record<string, unknown>, options: McpCallOptions) => {
  const { caller = 'model', authorize, approvalId, approvalContext, runContext, ...request } = options
  const { connectionId, name } = call
  const checks = toolGuards(manager, call, options)
  return Effect.gen(function* () {
    yield* checks.guard(false)
    const live = yield* authorized(manager, connectionId, { capability: 'tool', name }, request)
    yield* checks.guard(false)
    yield* checks.granted
    const tool = live.snapshot.tools.find((item) => item.name === name)
    if (tool === undefined || !toolOffered(tool, caller)) return yield* new NotFound({ what: `tool ${name}` })
    yield* fits(connectionId, args, manager.maxResultBytes)
    return yield* remote(manager, live, () =>
      manager.dispatch.request(checks.dispatch, { timeout: manager.requestTimeoutMs, ...request }, (guarded) =>
        live.client.callTool({ name, arguments: checks.frozen() }, guarded),
      ),
    )
  }).pipe(
    timed(
      { step: 'call', connectionId, tool: name, ...(runContext === undefined ? {} : { scope: runContext }) },
      manager.options.report,
    ),
  )
}

const readResource = (manager: Manager, connectionId: string, uri: string, max: number) =>
  Effect.gen(function* () {
    const live = yield* authorized(manager, connectionId, { capability: 'resource', name: uri }, {})
    if (live.snapshot.capabilities.resources === undefined)
      return yield* new UpstreamMcp({ connectionId, reason: 'unsupported' })
    return yield* remote(
      manager,
      live,
      () => live.client.readResource({ uri }, { timeout: manager.requestTimeoutMs }),
      max,
    )
  })

/** Only the owner's Apps host uses the larger HTML bundle bound; no model result takes this path. */
const readAppResource = (manager: Manager, connectionId: string, uri: string) =>
  Effect.gen(function* () {
    if (!uri.startsWith('ui://')) return yield* new UpstreamMcp({ connectionId, reason: 'unsupported' })
    const result = yield* readResource(manager, connectionId, uri, manager.options.maxAppResourceBytes ?? 16_777_216)
    const content = result.contents[0]
    const html =
      content !== undefined && 'text' in content && /^text\/html(?:\s*;[^\r\n]*)?$/iu.test(content.mimeType ?? '')
    if (result.contents.length !== 1 || content?.uri !== uri || !html)
      return yield* new UpstreamMcp({ connectionId, reason: 'unsupported' })
    return result
  })

/** One draft Events request: what the caller's `authorize` checks, before it connects and again before it is sent. */
type EventRequest<S extends Schema.ConstraintDecoder<unknown>> = {
  readonly method: EventMethod
  readonly params: Record<string, unknown>
  readonly schema: S
  readonly authorize: Effect.Effect<void, AppError>
}

const eventRequest = <S extends Schema.ConstraintDecoder<unknown>>(
  manager: Manager,
  connectionId: string,
  { method, params, schema, authorize }: EventRequest<S>,
) =>
  Effect.gen(function* () {
    yield* serverOf(manager, connectionId)
    yield* authorize
    const live = yield* connectionOf(manager, connectionId, { timeout: 5000 })
    if (!offersEvents(live.snapshot)) return yield* new UpstreamMcp({ connectionId, reason: 'unsupported' })
    yield* authorize
    const standard = Schema.toStandardSchemaV1(schema)
    const answer: S['Type'] = yield* remote(
      manager,
      live,
      () => live.client.request({ method, params }, standard, { timeout: 5000 }),
      262_144,
    ).pipe(timed({ step: 'events', connectionId, method }, manager.options.report))
    return answer
  })

/** Skills are read only from servers the owner turned them on for; nothing is opened otherwise. */
const skillsConnection = (manager: Manager, connectionId: string, { authorize, ...request }: SkillRequestOptions) =>
  Effect.gen(function* () {
    yield* serverOf(manager, connectionId)
    if (authorize !== undefined) yield* authorize(connectionId)
    if (manager.options.skillsEnabled?.(connectionId) !== true)
      return yield* new Forbidden({ reason: `skills are not enabled for ${connectionId}` })
    return yield* connectionOf(manager, connectionId, request)
  })

/** One skills request whose every dispatch checks the caller's authority and the owner's switch again. */
const skillRequest = <A>(
  manager: Manager,
  live: Connection,
  { authorize, ...request }: SkillRequestOptions,
  send: (request: RequestOptions) => Promise<A>,
  max?: number,
) => {
  const connectionId = live.server.connectionId
  const guard = Effect.gen(function* () {
    if (authorize !== undefined) yield* authorize(connectionId)
    if (manager.options.skillsEnabled?.(connectionId) !== true)
      return yield* new Forbidden({ reason: 'skills disabled' })
  })
  const timeout = manager.requestTimeoutMs
  return remote(manager, live, () => manager.dispatch.request(guard, { timeout, ...request }, send), max)
}

/** Every skill the server lists, page by page up to the page bound, with the shortest `ttlMs` seen. */
const listSkills = (manager: Manager, connectionId: string, options: SkillRequestOptions) =>
  Effect.gen(function* () {
    const live = yield* skillsConnection(manager, connectionId, options)
    if (!offersSkills(live.snapshot)) return { skills: [], ttlMs: undefined }
    const skills: SkillEntry[] = []
    let ttlMs: number | undefined
    let cursor: string | undefined
    for (let page = 0; page < manager.maxPages; page++) {
      const params = cursor === undefined ? {} : { cursor }
      const result = yield* skillRequest(manager, live, options, (guarded) =>
        live.client.request({ method: 'skills/list', params }, skillsListStandard, guarded),
      ).pipe(timed({ step: 'skills', connectionId }, manager.options.report))
      skills.push(...result.skills)
      if (result.ttlMs !== undefined) ttlMs = Math.min(ttlMs ?? result.ttlMs, result.ttlMs)
      if (result.nextCursor === undefined || result.nextCursor === cursor) break
      cursor = result.nextCursor
    }
    return { skills, ttlMs }
  })

const skillFile = (
  manager: Manager,
  connectionId: string,
  uri: string,
  options: SkillRequestOptions,
): Effect.Effect<ReadResourceResult, AppError> =>
  Effect.gen(function* () {
    const live = yield* skillsConnection(manager, connectionId, options)
    if (!offersSkills(live.snapshot)) return yield* new UpstreamMcp({ connectionId, reason: 'unsupported' })
    const max = manager.options.maxSkillFileBytes ?? 4_194_304
    return yield* skillRequest(manager, live, options, (guarded) => live.client.readResource({ uri }, guarded), max)
  })

/** The requests as the service answers them. */
const requests = (manager: Manager) => ({
  callTool: Effect.fn('McpConnections.callTool')(function* (
    connectionId: string,
    name: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ) {
    // Freeze the input before any wait; local guards and the SDK dispatch see the same object.
    return yield* callTool(manager, { connectionId, name, argumentsJson: JSON.stringify(args) }, args, options)
  }),
  readResource: Effect.fn('McpConnections.readResource')(function* (
    connectionId: string,
    uri: string,
    caller: 'human' | 'app',
  ) {
    return yield* caller === 'app'
      ? readAppResource(manager, connectionId, uri)
      : readResource(manager, connectionId, uri, manager.maxResultBytes)
  }),
  events: Effect.fn('McpConnections.events')(function* <S extends Schema.ConstraintDecoder<unknown>>(
    connectionId: string,
    method: EventMethod,
    params: Record<string, unknown>,
    schema: S,
    authorize: Effect.Effect<void, AppError>,
  ) {
    return yield* eventRequest(manager, connectionId, { method, params, schema, authorize })
  }),
  skills: Effect.fn('McpConnections.skills')(function* (connectionId: string, options: SkillRequestOptions = {}) {
    return yield* listSkills(manager, connectionId, options)
  }),
  skillFile: Effect.fn('McpConnections.skillFile')(function* (
    connectionId: string,
    uri: string,
    options: SkillRequestOptions = {},
  ) {
    return yield* skillFile(manager, connectionId, uri, options)
  }),
})

/**
 * One cached client per offered server, kept for the life of the layer that makes it. Connecting is one flight per
 * server; an idle connection is closed by a fiber in the layer's scope, and the layer's end closes them all. Every
 * call checks the owner's exact grant first, and results are size-bounded before they reach the host or the model.
 * Remote metadata is data, never authority.
 */
export const makeManager = Effect.fnUntraced(function* (options: McpManagerOptions) {
  const manager = yield* managerState(options)
  const service: McpManager = { ...lifecycle(manager), ...requests(manager) }
  return service
})
