/** Reading Pi transcript entries in smoke checks: the text of model messages, and a Delegate's reported result. */
import { Schema } from 'effect'

const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof ObjectSchema.Type
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))
const string = Schema.decodeUnknownSync(Schema.String)
const isObject = Schema.is(ObjectSchema)

/** Text from Pi's model messages, whether the provider returned a string or text content blocks. */
export function entryText(entry: JsonObject): string {
  return objects(entry['model'] ?? [])
    .flatMap((message) => {
      const content = message['content']
      return Array.isArray(content)
        ? objects(content).flatMap((block) => (block['text'] === undefined ? [] : [string(block['text'])]))
        : [string(content)]
    })
    .join(' ')
}

/**
 * Whether the Delegate `name` reported among `entries`: its result posted passively, which Goblin does not answer
 * again (ADR 0033), or, when the spawn asked for synthesis, its report as an input that an answer follows.
 */
export function delegateReported(entries: readonly JsonObject[], name: string): boolean {
  const passive = entries.some((entry) => {
    const data = entry['data']
    if (entry['kind'] !== 'app.delegate_result' || !isObject(data)) return false
    return data['name'] === name && typeof data['text'] === 'string' && data['text'].trim() !== ''
  })
  const report = entries.findIndex(
    (entry) => entry['kind'] === 'pi.user' && entryText(entry).includes(`[from subagent ${name}]`),
  )
  const answered =
    report >= 0 &&
    entries.slice(report + 1).some((entry) => entry['kind'] === 'pi.assistant' && entryText(entry).trim() !== '')
  return passive || answered
}
