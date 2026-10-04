import type { EntryRecord } from '@earendil-works/pi-durable'
import { textBlocks } from '../pi/transcript.ts'

/**
 * A message of main's memory, after OptChat's log: `user` (the owner's words, or another author's, tagged
 * `[from …]`), `talk` (the agent's reply, its tool calls as `tool:` lines) and `echo` (a tool's result).
 */
export type LogKind = 'user' | 'talk' | 'echo'
export type LogMessage = { readonly kind: LogKind; readonly text: string }

/** The longest text a message keeps for the memory: its head and tail, with a note of what was cut. */
const CAP = 12_000

function capped(text: string): string {
  if (text.length <= CAP) return text
  const half = CAP / 2
  return `${text.slice(0, half)}\n[… ${text.length - CAP} characters cut …]\n${text.slice(-half)}`
}

/** The memory's message for a main entry, or none for entries it leaves out (system, compaction, its own views). */
export function logMessage(entry: Pick<EntryRecord, 'kind' | 'model'>): LogMessage | undefined {
  const message = entry.model?.[0]
  if (message === undefined) return undefined
  if ((entry.kind === 'pi.user' || entry.kind === 'app.shared') && message.role === 'user')
    return { kind: 'user', text: capped(textBlocks(message.content).join('\n')) }
  if (entry.kind === 'pi.assistant' && message.role === 'assistant') {
    const lines = message.content.flatMap((block) => {
      if (block.type === 'text') return block.text === '' ? [] : [block.text]
      return block.type === 'toolCall' ? [`tool: ${block.name} ${JSON.stringify(block.arguments)}`] : []
    })
    return lines.length === 0 ? undefined : { kind: 'talk', text: capped(lines.join('\n')) }
  }
  if (entry.kind === 'pi.tool-result' && message.role === 'toolResult')
    return { kind: 'echo', text: capped(`${message.toolName}: ${textBlocks(message.content).join('\n')}`) }
  return undefined
}

/** A message as the summarizer and `zoom` show it: `kind: text`. */
export const messageLine = (message: LogMessage): string => `${message.kind}: ${message.text}`
