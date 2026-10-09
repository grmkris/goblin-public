import { Option, Schema } from 'effect'
import { isString, record } from './boundary.ts'

/** A saved-answer pointer, never the answer or a capability. */
const QuestionAnswerReceipt = Schema.Struct({
  type: Schema.Literal('myplan.question.answer'),
  version: Schema.Literal(1),
  workspaceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  itemId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  questionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  answerOperationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
})
export type QuestionAnswerReceipt = typeof QuestionAnswerReceipt.Type
const decodeReceipt = Schema.decodeUnknownOption(QuestionAnswerReceipt, { onExcessProperty: 'error' })
const MESSAGE_LIMIT = 8192

/** Only the bounded question receipt is accepted; unsupported blocks and extra receipt fields are refused. */
export function questionAnswerReceipt(content: readonly unknown[]): QuestionAnswerReceipt | undefined {
  if (content.length !== 1) return undefined
  const block = record(content[0])
  if (block?.type !== 'text' || !isString(block.text)) return undefined
  if (block.text.length === 0 || new TextEncoder().encode(block.text).byteLength > MESSAGE_LIMIT) return undefined
  let value: unknown
  try {
    value = JSON.parse(block.text)
  } catch {
    // expected: a message that is not JSON is no answer receipt, and is refused
    return undefined
  }
  const receipt = Option.getOrUndefined(decodeReceipt(value))
  if (receipt === undefined) return undefined
  try {
    const url = new URL(receipt.url)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  } catch {
    // expected: a receipt whose link is not a URL is refused
    return undefined
  }
  return receipt
}

/** Canonical pointer encoding keeps reload and field-order changes on the same answer operation. */
export function receiptText(receipt: QuestionAnswerReceipt): string {
  return JSON.stringify({
    type: receipt.type,
    version: receipt.version,
    workspaceId: receipt.workspaceId,
    itemId: receipt.itemId,
    threadId: receipt.threadId,
    questionId: receipt.questionId,
    answerOperationId: receipt.answerOperationId,
    url: receipt.url,
  })
}

/** A stable Pi submission id for this App and answer receipt; no claim about general App message delivery. */
export async function receiptOperationId(app: string, receipt: QuestionAnswerReceipt): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${app}:${receiptText(receipt)}`))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `app-message:${app}:${hex}`
}

/** Owner instructions are local text; the remote receipt travels only as untrusted App context. */
export function answerContinuation(app: string, serverId: string, resourceUri: string, receipt: QuestionAnswerReceipt) {
  return {
    input: 'Continue with the saved MyPlan answer.',
    appContext: [{ app, text: JSON.stringify({ from: 'mcp-app', serverId, resourceUri, receipt }) }],
  }
}
