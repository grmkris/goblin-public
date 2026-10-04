// What an MCP App hands the host for the owner and the agent: links to open, and context to share with the next
// message. Both come from the App, so both are untrusted: links open only on the owner's click, context travels as
// a labelled block the agent treats as data.
import type { AppContext } from '@purrable/contracts'
import { isString, record, records } from './boundary.ts'

const MAX_CONTEXT = 8192

/** The text an App shared (`ui/update-model-context`): its text blocks, else its structured content as JSON. */
export function contextText(content: unknown, structured: unknown): string {
  const text = records(content)
    .filter((block) => block.type === 'text' && isString(block.text))
    .map((block) => String(block.text))
    .join('\n')
    .trim()
  const shared = text !== '' ? text : structured === undefined ? '' : JSON.stringify(structured)
  return shared.slice(0, MAX_CONTEXT)
}

/** A link an App may offer the owner: https only, no credentials in it; otherwise nothing. */
export function safeLink(url: string): URL | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The App context blocks the runtime added after the owner's words (`pi/app-context.ts`). Only blocks after the
 * first count, so nothing the owner typed is ever read as App context.
 */
export function sharedContext(content: unknown): { readonly text: string; readonly context: readonly AppContext[] } {
  if (isString(content)) return { text: content, context: [] }
  const blocks = records(content).filter((block) => block.type === 'text' && isString(block.text))
  const [first, ...rest] = blocks.map((block) => String(block.text))
  const context = rest.flatMap((block): AppContext[] => {
    try {
      const value = record(JSON.parse(block))
      const origin = record(value?.origin)
      return isString(origin?.serverId) && origin.trust === 'untrusted' && isString(value?.appContext)
        ? [{ serverId: origin.serverId, text: value.appContext }]
        : []
    } catch {
      return []
    }
  })
  return {
    text: context.length === rest.length ? (first ?? '') : blocks.map((block) => block.text).join('\n'),
    context,
  }
}

/** The first line of shared context, short enough for a chip. */
export function contextPreview(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line.trim()
}
