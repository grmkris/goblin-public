import { Schema } from 'effect'
import type { JsonValue } from '@goblin/contracts'
import { isString, record, records } from './boundary.ts'

type PayloadBlock =
  | { readonly kind: 'json'; readonly value: JsonValue }
  | { readonly kind: 'text'; readonly text: string }

const isJson = Schema.is(Schema.MutableJson)

/** Parse a complete text block only; mixed prose and model-envelope metadata stay intact in Raw. */
function textBlock(text: string): PayloadBlock {
  try {
    const value: unknown = JSON.parse(text)
    if (isJson(value)) return { kind: 'json', value }
  } catch {
    // Tool results may be ordinary text, errors or incomplete JSON; all remain readable.
  }
  return { kind: 'text', text }
}

function isMcpEnvelope(details: Record<string, unknown> | undefined): details is Record<string, unknown> {
  const origin = record(details?.['origin'])
  return origin?.['trust'] === 'untrusted' && isString(origin['serverId']) && Array.isArray(details?.['content'])
}

function structuredBlock(
  details: Record<string, unknown>,
): Extract<PayloadBlock, { readonly kind: 'json' }> | undefined {
  const value = details['structuredContent']
  return value !== '[unsupported]' && isJson(value) ? { kind: 'json', value } : undefined
}

function contentBlocks(details: Record<string, unknown>): readonly PayloadBlock[] {
  const blocks: PayloadBlock[] = []
  for (const content of records(details['content'])) {
    const text = content['text']
    const block =
      content['type'] === 'text' && isString(text)
        ? textBlock(text)
        : isJson(content)
          ? { kind: 'json' as const, value: content }
          : undefined
    if (block === undefined) continue
    blocks.push(block)
  }
  return blocks
}

/** The MCP envelope already contains redacted structured output and original content blocks. */
export function outputBlocks(result: { readonly text: string; readonly details: unknown }): readonly PayloadBlock[] {
  const details = record(result.details)
  if (!isMcpEnvelope(details)) return [textBlock(result.text)]
  const structured = structuredBlock(details)
  const encoded = structured === undefined ? undefined : JSON.stringify(structured.value)
  const content = contentBlocks(details).filter(
    (block) => block.kind !== 'json' || encoded === undefined || JSON.stringify(block.value) !== encoded,
  )
  if (structured === undefined && content.length === 0) return [textBlock(result.text)]
  return [...(structured === undefined ? [] : [structured]), ...content]
}
