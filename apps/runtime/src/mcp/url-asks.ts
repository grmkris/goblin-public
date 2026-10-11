import {
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolResult,
  type Client,
  type InputRequiredResult,
  type JsonSchemaType,
  ProtocolError,
  ProtocolErrorCode,
  type RequestOptions,
  type Tool,
  isInputRequiredResult,
} from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { UpstreamMcp } from '../http/errors.ts'
import { CLIENT_CAPABILITIES } from './remote.ts'
import type { UrlAnswer, UrlPrompt } from './types.ts'

// A model's tool call on a 2026 connection that may answer a URL request (ADR 0042): it declares URL elicitation for
// this one request, takes an `input_required` result back instead of failing, and reads what the server asks.

/** The longest link goblin shows the owner; a longer one is refused. */
const MAX_URL = 2048
/** The longest server message goblin keeps, cut at a character; it is shown as plain text. */
const MAX_MESSAGE = 1000

/** The one input request goblin answers: a url-mode elicitation. */
const UrlElicitation = Schema.Struct({
  method: Schema.Literal('elicitation/create'),
  params: Schema.Struct({ mode: Schema.Literal('url'), message: Schema.String, url: Schema.String }),
})

const unsupported = (connectionId: string) => new UpstreamMcp({ connectionId, reason: 'unsupported' })

/** An https link with no credentials, at most `MAX_URL` long, as the owner's card may show it. */
const linkOf = (url: string): string | undefined => {
  if (url.length > MAX_URL || !URL.canParse(url)) return undefined
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return undefined
  return parsed.href
}

const graphemes = new Intl.Segmenter()

/** A server's words as plain text: control characters other than line breaks dropped, cut at a whole character. */
const plain = (text: string): string => {
  // oxlint-disable-next-line no-control-regex -- the point is to drop control characters from the server's text.
  const visible = text.replaceAll(/[\u0000-\u0009\u000B-\u001F\u007F]/gu, '')
  return Array.from(graphemes.segment(visible), ({ segment }) => segment)
    .slice(0, MAX_MESSAGE)
    .join('')
}

/**
 * What the server asks in an `input_required` result, when it is one url-mode elicitation with an https link: anything
 * else (several requests, a form, sampling, a plain retry) is refused as unsupported, so nothing is shown or sent.
 */
export function urlPromptOf(connectionId: string, result: InputRequiredResult): UrlPrompt {
  const entries = Object.entries(result.inputRequests ?? {})
  const [entry] = entries
  if (entries.length !== 1 || entry === undefined) throw unsupported(connectionId)
  const [inputKey, request] = entry
  const decoded = Schema.decodeUnknownOption(UrlElicitation)(request)
  if (Option.isNone(decoded) || inputKey.length > 128) throw unsupported(connectionId)
  const url = linkOf(decoded.value.params.url)
  if (url === undefined) throw unsupported(connectionId)
  return { inputKey, requestState: result.requestState, url, message: plain(decoded.value.params.message) }
}

const validators = new CfWorkerJsonSchemaValidator()

/** A complete result checked against the tool's output schema, as the SDK's own `callTool` checks it. */
function checkOutput(tool: Tool, result: CallToolResult): CallToolResult {
  if (tool.outputSchema === undefined || result.isError === true) return result
  if (result.structuredContent === undefined)
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `Tool ${tool.name} has an output schema but did not return structured content`,
    )
  // SAFETY: an output schema is a JSON Schema object in the tools/list response the SDK validated; `$schema` is absent
  // or a string, never undefined.
  const schema = tool.outputSchema as JsonSchemaType
  if (!validators.getValidator(schema)(result.structuredContent).valid)
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "Structured content does not match the tool's output schema",
    )
  return result
}

/** The answer's place in the retried request: under the server's key, with its request state echoed byte for byte. */
const answered = (answer: UrlAnswer | undefined) =>
  answer === undefined
    ? {}
    : {
        inputResponses: { [answer.inputKey]: { action: answer.action } },
        ...(answer.requestState === undefined ? {} : { requestState: answer.requestState }),
      }

/** A call's outcome before what the server asks is read: its result, or the `input_required` it answered. */
export type AskingOutcome =
  | { readonly kind: 'complete'; readonly result: CallToolResult }
  | { readonly kind: 'input'; readonly result: InputRequiredResult }

/**
 * Calls `tool` declaring URL elicitation for this request only, or retries it with the owner's `answer`. The SDK's
 * own output check is left out (it would refuse an `input_required` result) and run here on a complete one; header
 * mirroring keeps the tool's input schema.
 */
export async function callAsking(
  client: Client,
  tool: Tool,
  args: Record<string, unknown>,
  answer: UrlAnswer | undefined,
  options: RequestOptions,
): Promise<AskingOutcome> {
  const { outputSchema: _, ...unchecked } = tool
  const capabilities = { ...CLIENT_CAPABILITIES, elicitation: { url: {} } }
  const result = await client.callTool(
    {
      name: tool.name,
      arguments: args,
      _meta: { [CLIENT_CAPABILITIES_META_KEY]: capabilities },
      ...answered(answer),
    },
    { ...options, allowInputRequired: true, toolDefinition: unchecked },
  )
  if (isInputRequiredResult(result)) return { kind: 'input', result }
  return { kind: 'complete', result: checkOutput(tool, result) }
}
