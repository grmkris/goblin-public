import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ChannelStatus, ModelChoice, UsageToday } from '../agent.ts'
import { NonEmptyString } from '../ids.ts'
import { ApiErrors } from './errors.ts'

/** The owner's pick of a model the deployment offers. */
const ModelPick = Schema.Struct({ model: NonEmptyString(128) })
/** The connection to carry Telegram: a myagent connection bound to the agent's own bot. */
const ChannelPick = Schema.Struct({ serverId: NonEmptyString(64) })

/**
 * The agent itself: today's usage, its model, and its Telegram channel. Paths are relative to the API's `/api` prefix;
 * every endpoint can also answer owner admission's failures, and `error` names the ones the endpoint itself produces.
 *
 * - `usage`: `GET /api/agent/usage`, today's spend and allowance in Credits (ADR 0026).
 * - `model`, `chooseModel`: `GET`/`PUT /api/agent/model`. A pick moves main at once; other threads follow on their
 *   next turn. A model the deployment does not offer is invalid input.
 * - `channel`: `GET /api/agent/channel`, the connection carrying Telegram (ADR 0009), or null when it is off.
 * - `enableChannel`: `PUT /api/agent/channel` grants the connection's channel tools and subscribes its Events (or the
 *   legacy doorbell). A connection that lacks a tool is invalid input.
 * - `disableChannel`: `DELETE /api/agent/channel`, answered with null.
 */
export class AgentGroup extends HttpApiGroup.make('agent').add(
  HttpApiEndpoint.get('usage', '/agent/usage', { success: UsageToday }),
  HttpApiEndpoint.get('model', '/agent/model', { success: ModelChoice }),
  HttpApiEndpoint.put('chooseModel', '/agent/model', {
    payload: ModelPick,
    success: ModelChoice,
    error: [ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.get('channel', '/agent/channel', { success: ChannelStatus }),
  HttpApiEndpoint.put('enableChannel', '/agent/channel', {
    payload: ChannelPick,
    success: ChannelStatus,
    error: [ApiErrors.invalidInput, ApiErrors.upstream, ApiErrors.upstreamTimeout],
  }),
  HttpApiEndpoint.delete('disableChannel', '/agent/channel', { success: Schema.Null }),
) {}
