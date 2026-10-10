import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { WorkspaceChange, WorkspaceSnapshot } from '@goblin/contracts'
import { type NativeCase, probeOf } from './native-case.ts'

/** A model request as the probe recorded it. */
export const ModelRequest = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
  systemPrompt: Schema.String,
  tools: Schema.Array(Schema.String),
})
/** A request's turns, without the system messages Pi places among them. */
export const requestTurns = (request: typeof ModelRequest.Type) =>
  request.messages.filter(({ role }) => role !== 'system').map(({ text }) => text)
/** An owner API call that answered, with its value (`ownerResult`). */
export const Ok = <S extends Schema.Top>(value: S) => Schema.Struct({ ok: Schema.Literal(true), value })
/** An owner API call the agent refused, with its failure's tag (`ownerResult`). */
export const Refused = Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ _tag: Schema.String }) })
/** A Pi operation as it settled. */
export const Settled = Schema.Struct({ status: Schema.Literal('done'), text: Schema.String })

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
async function treeChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'tree', TreeRun)
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
  doneClosed: Listed,
  status: Schema.Struct({ text: Schema.optional(Schema.String) }),
  branch: Listed,
  request: ModelRequest,
  subagentAfter: Listed,
  closed: Ok(Listed),
  branchAfter: Listed,
  keepOpenThread: Refused,
})

/** A subagent closes once its job is done; a thread branched from it (reopened) is the owner's, and keeps it open. */
async function subagentBranchChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'subagent-branch', SubagentBranchRun)
  expect(result.doneClosed.closedBy).toBe('done')
  expect(result.branch).toMatchObject({ kind: 'thread', parent: result.subagentAfter.id })
  expect(requestTurns(result.request)).toEqual(['find the word', 'echo: find the word', 'what did you find?'])
  expect(result.request.tools).toEqual(expect.arrayContaining(['share_back', 'ask_user']))
  expect(result.status.text).toBe('done: No subagents.')
  // Historical section deltas remain in the fork; its current prompt must clear the subagent instructions.
  expect(result.request.systemPrompt).not.toContain('You are the subagent')
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

/** The workspace feed sends a snapshot, then each conversation change (a read mark too) and what each is doing. */
async function feedChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'feed', FeedRun)
  expect(result.snapshot.data.conversations.map(({ kind }) => kind)).toEqual(['main'])
  expect(result.snapshot.data.activity).toEqual([])
  expect(result.snapshot.data.apps).toEqual([])
  const steps = result.changes.flatMap((change) => {
    if (change.type === 'activity') return change.activity.id === result.id ? [`activity ${change.activity.state}`] : []
    if (change.type !== 'conversation' || change.conversation.id !== result.id) return []
    const { closedBy, replies, readAt } = change.conversation
    return [`conversation ${closedBy ?? 'open'} ${replies}${readAt === undefined ? '' : ' read'}`]
  })
  expect(steps[0]).toBe('conversation open 0')
  expect(steps).toContain('activity working')
  expect(steps.indexOf('activity idle')).toBeGreaterThan(steps.indexOf('activity working'))
  expect(steps).toContain('conversation open 2')
  expect(steps.indexOf('conversation open 2 read')).toBeGreaterThan(steps.indexOf('conversation open 2'))
  expect(steps.at(-1)).toBe('conversation owner 2 read')
  const read = result.changes.flatMap((change) =>
    change.type === 'conversation' && change.conversation.id === result.id ? [change.conversation] : [],
  )
  const marked = read.find(({ readAt }) => readAt !== undefined)
  expect(marked?.readAt).toBeGreaterThanOrEqual(marked?.lastReplyAt ?? Number.POSITIVE_INFINITY)
}

/** A transcript's turns, without the system prompt and memory view entries placed among them for the model. */
const turns = (lines: readonly string[]) =>
  lines.filter((line) => !line.startsWith('pi.system') && !line.startsWith('app.memory'))

/** The subagent tools among a request's tools. */
const offered = (tools: readonly string[] = []) => tools.filter((tool) => tool.startsWith('subagent'))

const Activity = Schema.Struct({
  createdAt: Schema.Number,
  forkEntry: Schema.Number,
  replies: Schema.Number,
  lastReplyAt: Schema.optional(Schema.Number),
})
const Branch = Schema.Struct({
  thread: Schema.Struct({ kind: Schema.Literal('thread'), parent: Schema.Literal('1') }),
  settled: Settled,
  main: Schema.Array(Schema.String),
  branch: Schema.Array(Schema.String),
  request: ModelRequest,
  forkedAt: Schema.Number,
  before: Activity,
  afterOne: Activity,
  afterTwo: Activity,
})

/** A thread branched from main sees main up to the branch, and main never sees the thread. */
async function branchChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'branch', Branch)
  expect(result.settled.text).toBe('echo: what was the word?')
  expect(turns(result.main)).toEqual([
    'pi.user: "remember the word lantern"',
    'pi.assistant: [{"type":"text","text":"echo: remember the word lantern"}]',
  ])
  expect(turns(result.branch)).toEqual([
    ...turns(result.main),
    'pi.user: "what was the word?"',
    'pi.assistant: [{"type":"text","text":"echo: what was the word?"}]',
  ])
  expect(requestTurns(result.request)).toEqual([
    'remember the word lantern',
    'echo: remember the word lantern',
    'what was the word?',
  ])
  // The thread list knows where the thread branched and counts only what was said in it.
  expect(result.before).toMatchObject({ forkEntry: result.forkedAt, replies: 0 })
  expect(result.before.lastReplyAt).toBeUndefined()
  expect(result.afterOne).toMatchObject({ forkEntry: result.forkedAt, replies: 2 })
  expect(result.afterOne.lastReplyAt).toBeGreaterThanOrEqual(result.afterOne.createdAt)
  expect(result.afterTwo.replies).toBe(4)
}

const Share = Schema.Struct({
  shared: Settled,
  main: Schema.Array(Schema.String),
  mainRequest: ModelRequest,
  threadRequest: ModelRequest,
  title: Schema.String,
})

/** A thread shares a note with main, which main sees as context without answering it. */
async function shareChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'share', Share)
  expect(result.shared.text).toBe('done: Shared with main.')
  const note = [
    { type: 'text', text: '[from thread (untitled)]' },
    { type: 'text', text: 'the word is lantern' },
  ]
  expect(turns(result.main)).toEqual([
    'pi.user: "remember the word lantern"',
    'pi.assistant: [{"type":"text","text":"echo: remember the word lantern"}]',
    `app.shared: ${JSON.stringify(note)}`,
    'pi.user: "what did the thread say?"',
    'pi.assistant: [{"type":"text","text":"echo: what did the thread say?"}]',
  ])
  // Main's background memory builder may compact the earlier exchange before this request.
  const requested = requestTurns(result.mainRequest)
  expect(requested.join('\n')).toContain('remember the word lantern')
  expect(requested.join('\n')).toContain('echo: remember the word lantern')
  expect(requested.slice(-2)).toEqual(['[from thread (untitled)]\nthe word is lantern', 'what did the thread say?'])
  expect(result.threadRequest.tools).toContain('share_back')
  expect(result.mainRequest.tools).not.toContain('share_back')
  // The cheap model (scripted: it echoes the last line) was asked to name the thread's latest exchange.
  expect(result.title).toBe('echo: Agent: done: Shared with main.')
}

const Announce = Schema.Struct({
  thread: Schema.String,
  title: Schema.String,
  first: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.Unknown),
  main: Schema.Array(Schema.String),
  request: ModelRequest,
})

/** A thread started with + tells main its name once, and a branched thread tells it nothing. */
async function announceChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'announce', Announce)
  const note = `[thread started: "${result.title}"]`
  expect(result.first).toEqual([`app.thread_started: ${JSON.stringify([{ type: 'text', text: note }])}`])
  // One note however often the thread answers, naming the thread; the branched thread added none.
  expect(result.notes).toEqual([{ thread: result.thread }])
  // The note started no run in main: the next line in main is the owner's own question.
  expect(turns(result.main).slice(2)).toEqual([
    `app.thread_started: ${JSON.stringify([{ type: 'text', text: note }])}`,
    'pi.user: "which threads did I start?"',
    'pi.assistant: [{"type":"text","text":"echo: which threads did I start?"}]',
  ])
  expect(requestTurns(result.request)).toContain(note)
}

const Tools = Schema.optional(Schema.Array(Schema.String))
const SetupRun = Schema.Struct({
  narrow: Ok(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  thread: Ok(Schema.Struct({ id: Schema.String })),
  tools: Schema.Struct({ main: Tools, narrow: Tools, thread: Tools }),
  off: Settled,
  offDetails: Schema.Unknown,
  listed: Settled,
})

/** A Topic's setup bounds its Conversation and threads: subagents off, one tool of one server (ADR 0040). */
async function setupChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'setups', SetupRun)
  // Pi's tool filter follows the setup: no subagent tool where the Topic does not allow subagents.
  expect(result.tools.main).toContain('mcp_call')
  expect(offered(result.tools.main)).toEqual([
    'subagent_spawn',
    'subagent_send',
    'subagent_stop',
    'subagent_config',
    'subagent_status',
  ])
  expect(result.tools.narrow).toContain('mcp_call')
  expect(offered(result.tools.narrow)).toEqual([])
  expect(offered(result.tools.thread)).toEqual([])
  // The tool outside the setup ran nothing: the gate answered before the grant check or any connection to notes.test.
  expect(result.off.text).toContain("Not in #Narrow's setup: notes · write. Nothing ran.")
  expect(result.offDetails).toEqual({
    kind: 'not-in-topic',
    target: { kind: 'tool', serverId: 'notes', name: 'write' },
    topic: { id: result.narrow.value.id, name: 'Narrow' },
  })
  expect(result.listed.text).toContain('"serverId":"notes"')
}

const SubagentRun = Schema.Struct({
  spawned: Settled,
  main: Schema.Array(Schema.String),
  subagent: Schema.Struct({ kind: Schema.Literal('subagent'), title: Schema.String, parent: Schema.String }),
  child: Schema.Array(Schema.String),
  mainRequest: ModelRequest,
  childRequest: ModelRequest,
})

/** A subagent works in the background and its answer is posted in main as a passive result main does not answer. */
async function subagentChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'subagent', SubagentRun)
  expect(result.spawned.text).toBe('done: Started scout.')
  expect(result.subagent).toEqual({ kind: 'subagent', title: 'scout', parent: '1' })
  expect(turns(result.child)).toEqual([
    'pi.user: "find the word"',
    'pi.assistant: [{"type":"text","text":"echo: find the word"}]',
  ])
  const report = [
    { type: 'text', text: '[from subagent scout]' },
    { type: 'text', text: 'echo: find the word' },
  ]
  expect(turns(result.main).at(-1)).toBe(`app.delegate_result: ${JSON.stringify(report)}`)
  expect(turns(result.main).filter((line) => line.includes('echo: echo: find the word'))).toEqual([])
  expect(result.mainRequest.tools).toEqual(expect.arrayContaining(['subagent_spawn', 'ask_user', 'mcp_call']))
  expect(result.childRequest.tools).toEqual(expect.arrayContaining(['mcp_list', 'mcp_call', 'subagent_spawn']))
  expect(result.childRequest.tools).not.toContain('ask_user')
}

/** Threads, switches, subagents in main, the conversation tree and the workspace feed. */
export const cases: readonly NativeCase[] = [
  {
    title: 'a thread branched from main sees main up to the branch, and main never sees the thread',
    run: branchChecks,
  },
  {
    title: 'a thread shares a note with main, which main sees as context without answering it',
    run: shareChecks,
  },
  {
    title: 'a thread started with + tells main its name once, and a branched thread tells it nothing',
    run: announceChecks,
  },
  {
    title: "a Topic's setup bounds its Conversation and threads: no subagents, one tool of one server",
    run: setupChecks,
  },
  {
    title:
      'a subagent works in the background and its answer is posted in main as a passive result main does not answer',
    run: subagentChecks,
  },
  {
    title: 'a thread branches from a thread, and Close shuts it with everything under it until Reopen',
    run: treeChecks,
  },
  { title: "a thread branched from a subagent is the owner's, and keeps it open", run: subagentBranchChecks },
  { title: 'the workspace feed sends a snapshot, then each change and what each is doing [canary]', run: feedChecks },
]
