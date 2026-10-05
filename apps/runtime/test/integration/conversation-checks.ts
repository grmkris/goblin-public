import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { WorkspaceChange, WorkspaceSnapshot } from '@purrable/contracts'

/** A model request as the probe recorded it. */
export const ModelRequest = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
  tools: Schema.Array(Schema.String),
})
/** A request's turns, without the system messages Pi places among them. */
export const requestTurns = (request: typeof ModelRequest.Type) =>
  request.messages.filter(({ role }) => role !== 'system').map(({ text }) => text)
/** An owner RPC that answered, with its value. */
export const Ok = <S extends Schema.Top>(value: S) => Schema.Struct({ ok: Schema.Literal(true), value })
/** An owner RPC the agent refused. */
export const Refused = Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) })

/** Runs one probe sequence of the native worker and decodes its answer. */
const probe = <A>(base: string, path: string, name: string, schema: Schema.Decoder<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => fetch(`${base}/${path}?name=${name}`))
      return yield* Schema.decodeUnknownEffect(schema)(yield* Effect.promise(() => response.json()))
    }),
  )

/** A conversation as the registry lists it, as far as these checks read it. */
export const Listed = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  parent: Schema.optional(Schema.String),
  closedAt: Schema.optional(Schema.Number),
  closedBy: Schema.optional(Schema.String),
  keepOpen: Schema.Boolean,
})
const TreeRun = Schema.Struct({
  outer: Listed,
  nested: Listed,
  nestedRequest: ModelRequest,
  working: Schema.Boolean,
  closed: Ok(Listed),
  stopped: Schema.Boolean,
  closedViews: Schema.Array(Listed),
  refused: Refused,
  reopened: Ok(Listed),
  reopenedViews: Schema.Array(Listed),
  subagent: Schema.String,
  main: Refused,
})

/** Whether each conversation is closed, by id. */
const closedness = (views: readonly (typeof Listed.Type)[]) =>
  Object.fromEntries(views.map(({ id, closedBy }) => [id, closedBy ?? 'open']))

/** A thread branches from a thread, and Close shuts it with everything under it until Reopen. */
export async function treeChecks(base: string, name: string): Promise<void> {
  const result = await probe(base, 'tree', name, TreeRun)
  expect(result.outer.parent).toBe('1')
  expect(result.nested.parent).toBe(result.outer.id)
  // The nested thread read main and the outer thread up to its branch point, and nothing after it.
  expect(requestTurns(result.nestedRequest)).toEqual([
    'remember the word lantern',
    'echo: remember the word lantern',
    'what was the word?',
    'echo: what was the word?',
    'and in the nested thread?',
  ])
  expect(result.working).toBe(true)
  expect(result.closed.value).toMatchObject({ id: result.outer.id, closedBy: 'owner' })
  expect(result.stopped).toBe(true)
  expect(closedness(result.closedViews)).toMatchObject({
    '1': 'open',
    [result.outer.id]: 'owner',
    [result.nested.id]: 'owner',
    [result.subagent]: 'owner',
  })
  expect(result.refused.error._tag).toBe('InvalidInput')
  expect(result.reopened.value.closedAt).toBeUndefined()
  expect(closedness(result.reopenedViews)).toMatchObject({
    [result.outer.id]: 'open',
    [result.nested.id]: 'owner',
    [result.subagent]: 'owner',
  })
  expect(result.main.error._tag).toBe('InvalidInput')
}

const SubagentBranchRun = Schema.Struct({
  branch: Listed,
  request: ModelRequest,
  subagentAfter: Listed,
  closed: Ok(Listed),
  branchAfter: Listed,
  keepOpenThread: Refused,
})

/** A thread branched from a subagent is the owner's, and keeps the subagent open. */
export async function subagentBranchChecks(base: string, name: string): Promise<void> {
  const result = await probe(base, 'subagent-branch', name, SubagentBranchRun)
  expect(result.branch).toMatchObject({ kind: 'thread', parent: result.subagentAfter.id })
  expect(requestTurns(result.request)).toEqual(['find the word', 'echo: find the word', 'what did you find?'])
  expect(result.request.tools).toEqual(expect.arrayContaining(['share_back', 'ask_user', 'subagent']))
  expect(result.request.messages.some(({ text }) => text.includes('You are the subagent'))).toBe(false)
  expect(result.subagentAfter.keepOpen).toBe(true)
  expect(result.closed.value.closedBy).toBe('owner')
  expect(result.branchAfter.closedBy).toBe('owner')
  expect(result.keepOpenThread.error._tag).toBe('InvalidInput')
}

const FeedRun = Schema.Struct({
  snapshot: Schema.Struct({ event: Schema.Literal('snapshot'), data: WorkspaceSnapshot }),
  id: Schema.String,
  changes: Schema.Array(WorkspaceChange),
})

/** The workspace feed sends a snapshot, then each conversation change and what each is doing. */
export async function feedChecks(base: string, name: string): Promise<void> {
  const result = await probe(base, 'feed', name, FeedRun)
  expect(result.snapshot.data.conversations.map(({ kind }) => kind)).toEqual(['main'])
  expect(result.snapshot.data.activity).toEqual([])
  const mine = result.changes.filter((change) =>
    change.type === 'activity' ? change.activity.id === result.id : change.conversation.id === result.id,
  )
  const steps = mine.map((change) =>
    change.type === 'activity'
      ? `activity ${change.activity.state}`
      : `conversation ${change.conversation.closedBy ?? 'open'} ${change.conversation.replies}`,
  )
  expect(steps[0]).toBe('conversation open 0')
  expect(steps).toContain('activity working')
  expect(steps.indexOf('activity idle')).toBeGreaterThan(steps.indexOf('activity working'))
  expect(steps).toContain('conversation open 2')
  expect(steps.at(-1)).toBe('conversation owner 2')
}
