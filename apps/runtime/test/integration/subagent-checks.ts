import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { Listed, ModelRequest, Ok } from './conversation-checks.ts'

const decode = async <A>(base: string, path: string, name: string, schema: Schema.Decoder<A>) =>
  Schema.decodeUnknownPromise(schema)(await (await fetch(`${base}/${path}?name=${name}`)).json())

const Lines = Schema.Array(Schema.String)
const Settled = Schema.Struct({ status: Schema.String, text: Schema.optional(Schema.String) })
/** One report a spawner received from subagent `name`, as its transcript line. */
const reportsFrom = (lines: readonly string[], name: string) =>
  lines.filter((line) => line.includes(`[from subagent ${name}]`))

const ChainRun = Schema.Struct({
  main: Lines,
  lead: Listed,
  digger: Listed,
  leadLines: Lines,
  leadRequest: ModelRequest,
})

/** A subagent's subagent reports to it, and only its final answer reaches main; both close when done. */
export async function chainChecks(base: string, name: string): Promise<void> {
  const result = await decode(base, 'subagent-chain', name, ChainRun)
  const report = [
    { type: 'text', text: '[from subagent lead]' },
    { type: 'text', text: 'echo: echo: find deeper' },
  ]
  expect(reportsFrom(result.main, 'lead')).toEqual([`app.delegate_result: ${JSON.stringify(report)}`])
  // Main did not spawn lead with synthesize, so the result is the last thing in its transcript: no answer follows.
  expect(result.main.at(-1)).toBe(`app.delegate_result: ${JSON.stringify(report)}`)
  expect(reportsFrom(result.leadLines, 'digger')).toHaveLength(1)
  expect(result.lead).toMatchObject({ kind: 'subagent', parent: '1', closedBy: 'done' })
  expect(result.digger).toMatchObject({ kind: 'subagent', parent: result.lead.id, closedBy: 'done' })
  expect(result.leadRequest.tools).toContain('subagent_spawn')
  expect(result.leadRequest.tools).not.toContain('ask_user')
}

const OwnerRun = Schema.Struct({
  working: Schema.Boolean,
  sent: Ok(Schema.Struct({ accepted: Schema.Boolean })),
  settled: Settled,
  main: Lines,
  after: Listed,
  child: Lines,
})

/** The owner's message to a busy subagent steers it, reports up once with their words, and keeps it open. */
export async function ownerChecks(base: string, name: string): Promise<void> {
  const result = await decode(base, 'subagent-owner', name, OwnerRun)
  expect(result.working).toBe(true)
  expect(result.sent.value.accepted).toBe(true)
  expect(result.child.filter((line) => !line.startsWith('pi.system'))).toEqual([
    'pi.user: "Native slow job"',
    'pi.assistant: [{"type":"text","text":"echo: Native slow job"}]',
    'pi.user: "also check the attic"',
    'pi.assistant: [{"type":"text","text":"echo: also check the attic"}]',
  ])
  expect(result.settled).toEqual({ status: 'done', text: 'echo: also check the attic' })
  const reports = reportsFrom(result.main, 'scout')
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain('The owner wrote to it: \\"also check the attic\\"')
  expect(reports[0]).toContain('echo: also check the attic')
  expect(result.after).toMatchObject({ keepOpen: true })
  expect(result.after.closedAt).toBeUndefined()
}

const CloseRun = Schema.Struct({
  working: Schema.Boolean,
  stopped: Settled,
  diggerStopped: Schema.Boolean,
  closed: Ok(Listed),
  lead: Listed,
  digger: Listed,
  refused: Settled,
  done: Listed,
  reopened: Settled,
  again: Listed,
  main: Lines,
  leadLines: Lines,
  quickLines: Lines,
})

/** Stop and Close reach a subagent's subagents and report nothing; a send to an owner-closed one is refused. */
export async function closeChecks(base: string, name: string): Promise<void> {
  const result = await decode(base, 'subagent-close', name, CloseRun)
  expect(result.working).toBe(true)
  expect(result.stopped.text).toBe('done: Stopped lead.')
  expect(result.diggerStopped).toBe(true)
  expect(reportsFrom(result.main, 'lead')).toEqual([])
  expect(reportsFrom(result.leadLines, 'digger')).toEqual([])
  expect(result.closed.value.closedBy).toBe('owner')
  expect(result.lead.closedBy).toBe('owner')
  expect(result.digger.closedBy).toBe('owner')
  expect(result.refused.text).toBe('done: The owner closed lead; it takes no messages until they reopen it.')
  expect(result.done.closedBy).toBe('done')
  expect(result.reopened.text).toBe('done: Sent to quick; it had closed when its job was done and is open again.')
  expect(reportsFrom(result.main, 'quick')).toHaveLength(2)
  expect(result.quickLines.at(-1)).toBe('pi.assistant: [{"type":"text","text":"echo: once more"}]')
  expect(result.again.closedBy).toBe('done')
}

const SynthesisRun = Schema.Struct({
  passive: Lines,
  both: Lines,
  settled: Lines,
  quiet: Listed,
  loud: Listed,
})

/** A Delegate's result is passive unless the spawn asked for synthesis, which gets exactly one answer. */
export async function synthesisChecks(base: string, name: string): Promise<void> {
  const result = await decode(base, 'subagent-synthesis', name, SynthesisRun)
  const quiet = [
    { type: 'text', text: '[from subagent quiet]' },
    { type: 'text', text: 'echo: say little' },
  ]
  expect(reportsFrom(result.passive, 'quiet')).toEqual([`app.delegate_result: ${JSON.stringify(quiet)}`])
  expect(result.passive.at(-1)).toBe(`app.delegate_result: ${JSON.stringify(quiet)}`)
  const loud = [
    { type: 'text', text: '[from subagent loud]' },
    { type: 'text', text: 'echo: say more' },
  ]
  expect(reportsFrom(result.both, 'loud')).toEqual([`pi.user: ${JSON.stringify(loud)}`])
  expect(result.both.at(-1)).toBe('pi.assistant: [{"type":"text","text":"echo: echo: say more"}]')
  // Exactly one answer followed it, and the quiet result still has none.
  const afterLoud = result.settled.slice(result.settled.findIndex((line) => line.includes('[from subagent loud]')))
  expect(afterLoud.filter((line) => line.startsWith('pi.assistant'))).toHaveLength(1)
  expect(
    result.settled.slice(result.settled.findIndex((line) => line.includes('[from subagent quiet]')) + 1)[0],
  ).not.toMatch(/^pi\.assistant: .*echo: echo: say little/u)
  expect(result.quiet.closedBy).toBe('done')
  expect(result.loud.closedBy).toBe('done')
}
