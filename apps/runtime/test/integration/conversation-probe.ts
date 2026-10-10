import { type ConversationView, PRIMARY_CHAT } from '@goblin/contracts'
import type { AgentFetch } from '../owner-client.ts'
import { type Probes, type ProbeStub, agentProbe, inWorker } from './probe.ts'
import {
  branchMain,
  exchange,
  historyOf,
  linesOf,
  ownerCreate,
  ownerMarkRead,
  ownerResult,
  ownerSend,
  ownerUpdate,
  snapshotOf,
  threadsUntil,
  transcript,
  workspaceConversations,
} from './probe-reads.ts'
import { until } from './until.ts'

/** How the thread list shows one conversation now. */
const listedThread = async (agent: AgentFetch, id: string) =>
  (await workspaceConversations(agent)).find((view) => view.id === id)

/** The newest answer in a conversation: what a thread can branch from. */
const answerIn = async (agent: AgentFetch, session: string) =>
  ((await snapshotOf(agent, session)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')?.id

/** A conversation once Pi no longer runs it. */
const idle = async (agent: ProbeStub, view: ConversationView) => {
  await until(
    () => agent.busy(view.id),
    (busy) => !busy,
  )
  return view
}

/**
 * A thread branched at main's answer sees main up to there and goes on alone: main never sees the thread's turn, and
 * the thread's request carried main's history. The thread list counts only the thread's own messages, turn by turn.
 */
async function branchSequence(agent: ProbeStub) {
  await exchange(agent, PRIMARY_CHAT, 'remember the word lantern', 'branch-main')
  const answer = await answerIn(agent, PRIMARY_CHAT)
  const thread = await branchMain(agent, answer)
  if (!thread.ok) return { thread }
  const before = await listedThread(agent, thread.value.id)
  const settled = await exchange(agent, thread.value.id, 'what was the word?', 'branch-thread')
  const branch = await transcript(agent, thread.value.id)
  const afterOne = await listedThread(agent, thread.value.id)
  await exchange(agent, thread.value.id, 'and once more?', 'branch-thread-again')
  return {
    thread: thread.value,
    settled,
    main: await transcript(agent, PRIMARY_CHAT),
    branch,
    request: await agent.requestFor('what was the word?'),
    forkedAt: answer,
    before,
    afterOne,
    afterTwo: await listedThread(agent, thread.value.id),
  }
}

/** Main's newest answer, from its history. */
const mainHistoryAnswer = async (agent: AgentFetch) =>
  ((await historyOf(agent, PRIMARY_CHAT)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')?.id

/**
 * A thread shares a note with main: main's next request carries it, labelled with the thread, and it started no run
 * of its own. Only the thread is offered `share_back`, and the thread is named after its first exchange. The thread
 * is branched, so main gets no note of its start (that is for threads started with "+": `announceSequence`).
 */
async function shareSequence(agent: ProbeStub) {
  await exchange(agent, PRIMARY_CHAT, 'remember the word lantern', 'share-main')
  const thread = await branchMain(agent, await mainHistoryAnswer(agent))
  if (!thread.ok) return { thread }
  const share = 'call share_back {"note":"the word is lantern"}'
  const shared = await exchange(agent, thread.value.id, share, 'share-thread')
  await exchange(agent, PRIMARY_CHAT, 'what did the thread say?', 'share-ask')
  return {
    shared,
    main: await transcript(agent, PRIMARY_CHAT),
    mainRequest: await agent.requestFor('what did the thread say?'),
    threadRequest: await agent.requestFor(share),
    // The cheap model names the thread in the background.
    title: (await threadsUntil(agent, (views) => views.some(({ id, title }) => id === thread.value.id && title))).find(
      ({ id }) => id === thread.value.id,
    )?.title,
  }
}

/** Main's notes of threads started with "+", once they are in. */
const notesUntil = (agent: AgentFetch, count: number) =>
  until(
    async () => (await transcript(agent, PRIMARY_CHAT)).filter((line) => line.startsWith('app.thread_started')),
    (notes) => notes.length >= count,
  )

/**
 * A thread started with "+" tells main its name, once, after its first exchange names it: main's model reads the
 * note, no run starts for it, and a second exchange or a branched thread adds none.
 */
async function announceSequence(agent: ProbeStub) {
  await exchange(agent, PRIMARY_CHAT, 'remember the word lantern', 'announce-main')
  const fresh = await ownerCreate(agent, {})
  if (!fresh.ok) return { fresh }
  await exchange(agent, fresh.value.id, 'plan the trip', 'announce-thread')
  const first = await notesUntil(agent, 1)
  await exchange(agent, fresh.value.id, 'and the hotel?', 'announce-thread-again')
  const branched = await branchMain(agent, await mainHistoryAnswer(agent))
  if (!branched.ok) return { branched }
  await exchange(agent, branched.value.id, 'what was the word?', 'announce-branch')
  await threadsUntil(agent, (views) => views.some(({ id, title }) => id === branched.value.id && title))
  await exchange(agent, PRIMARY_CHAT, 'which threads did I start?', 'announce-ask')
  const mainEntries = (await historyOf(agent, PRIMARY_CHAT)).entries ?? []
  return {
    thread: fresh.value.id,
    title: (await listedThread(agent, fresh.value.id))?.title,
    first,
    notes: mainEntries.filter(({ kind }) => kind === 'app.thread_started').map(({ data }) => data),
    main: linesOf(mainEntries),
    request: await agent.requestFor('which threads did I start?'),
  }
}

/**
 * A Topic's setup (ADR 0040): "Narrow" holds only the notes server's `read` and no subagents. The `subagent` tools leave
 * the requests of its Conversation and of a "+" thread in it but stay in main (Personal holds everything); a call to a
 * tool the setup does not hold runs nothing and asks the owner to add it; `mcp_list` lists only the setup's servers.
 */
async function setupSequence(agent: ProbeStub) {
  await agentProbe(agent, 'seed-notes')
  const narrow = await ownerResult(agent, (api) =>
    api.topics.create({
      payload: {
        name: 'Narrow',
        operationId: 'setup-narrow',
        setup: { mcpServers: [{ serverId: 'notes', tools: ['read'] }], skills: [], apps: [], subagents: false },
      },
    }),
  )
  if (!narrow.ok) return { narrow }
  const chat = narrow.value.conversation
  await exchange(agent, PRIMARY_CHAT, 'which tools do you have?', 'setup-main')
  await exchange(agent, chat, 'and in Narrow?', 'setup-narrow')
  const thread = await ownerCreate(agent, { topic: narrow.value.id })
  if (!thread.ok) return { narrow, thread }
  await exchange(agent, thread.value.id, 'and in its thread?', 'setup-thread')
  // A tool outside the setup runs nothing (the unreachable server is never asked) and the result offers it to the owner.
  const offCall = 'call mcp_call {"serverId":"notes","name":"write","arguments":{}}'
  const off = await exchange(agent, chat, offCall, 'setup-off-call')
  const offResult = ((await historyOf(agent, chat)).entries ?? []).findLast(({ kind }) => kind === 'pi.tool-result')
  const listed = await exchange(agent, chat, 'call mcp_list {}', 'setup-list')
  const tools = async (turn: string) => (await agent.requestFor(turn))?.tools
  return {
    narrow,
    thread,
    off,
    offDetails: offResult?.model?.[0]?.details,
    listed,
    tools: {
      main: await tools('which tools do you have?'),
      narrow: await tools('and in Narrow?'),
      thread: await tools('and in its thread?'),
    },
  }
}

/**
 * Main spawns a subagent: it works in its own conversation with the owner's tools but no subagents or ask_user, and
 * its answer comes back into main as a passive Delegate result labelled with it, which main does not answer.
 */
async function subagentSequence(agent: ProbeStub) {
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'scout', message: 'find the word' })}`
  const spawned = await exchange(agent, PRIMARY_CHAT, spawn, 'subagent-spawn')
  await until(
    () => transcript(agent, PRIMARY_CHAT),
    (lines) => lines.some((line) => line.includes('[from subagent')),
  )
  // The report is a passive Delegate result: a Goblin run that wrongly followed it would show after a moment.
  await new Promise((resolve) => setTimeout(resolve, 600))
  const main = await transcript(agent, PRIMARY_CHAT)
  const listed = (await threadsUntil(agent, (views) => views.some(({ kind }) => kind === 'subagent'))).find(
    ({ kind }) => kind === 'subagent',
  )
  const subagent = listed === undefined ? undefined : await idle(agent, listed)
  return {
    spawned,
    main,
    subagent,
    child: subagent === undefined ? [] : await transcript(agent, subagent.id),
    mainRequest: await agent.requestFor(spawn),
    childRequest: await agent.requestFor('find the word'),
  }
}

/**
 * Conversations form a tree: a thread branches from another thread, Close shuts a thread with everything under it (its
 * subagent stops mid-job), a closed conversation takes no message, and Reopen opens only the one asked for.
 */
async function treeSequence(agent: ProbeStub) {
  await exchange(agent, PRIMARY_CHAT, 'remember the word lantern', 'tree-main')
  const outer = await branchMain(agent, await answerIn(agent, PRIMARY_CHAT))
  if (!outer.ok) return { outer }
  await exchange(agent, outer.value.id, 'what was the word?', 'tree-outer')
  const entry = (await answerIn(agent, outer.value.id)) ?? 0
  const nested = await ownerCreate(agent, { from: { conversation: outer.value.id, entry } })
  if (!nested.ok) return { nested }
  await exchange(agent, nested.value.id, 'and in the nested thread?', 'tree-nested')
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'digger', message: 'Native slow job' })}`
  await exchange(agent, outer.value.id, spawn, 'tree-spawn')
  const subagent = (await threadsUntil(agent, (views) => views.some(({ parent }) => parent === outer.value.id))).find(
    ({ kind, parent }) => kind === 'subagent' && parent === outer.value.id,
  )
  if (subagent === undefined) return { subagent }
  const working = await until(
    () => agent.busy(subagent.id),
    (busy) => busy,
  )
  const closed = await ownerUpdate(agent, outer.value.id, { closed: true })
  const stopped = !(await agent.busy(subagent.id))
  const closedViews = await workspaceConversations(agent)
  const refused = await ownerSend(agent, nested.value.id, 'still there?', 'tree-refused')
  const reopened = await ownerUpdate(agent, outer.value.id, { closed: false })
  const reopenedViews = await workspaceConversations(agent)
  const main = await ownerUpdate(agent, PRIMARY_CHAT, { closed: true })
  return {
    outer: outer.value,
    nested: nested.value,
    nestedRequest: await agent.requestFor('and in the nested thread?'),
    working,
    closed,
    stopped,
    closedViews,
    refused,
    reopened,
    reopenedViews,
    subagent: subagent.id,
    main,
  }
}

/**
 * A thread branched from a subagent's answer is an owner's thread: its agent is the host's (with `ask_user` and
 * subagents, without the subagent's instructions), it reads the subagent's work, and the subagent stays open for it.
 */
async function subagentBranchSequence(agent: ProbeStub) {
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'scout', message: 'find the word' })}`
  await exchange(agent, PRIMARY_CHAT, spawn, 'subagent-branch-spawn')
  const listed = (await threadsUntil(agent, (views) => views.some(({ kind }) => kind === 'subagent'))).find(
    ({ kind }) => kind === 'subagent',
  )
  if (listed === undefined) return { listed }
  // Its job done, the subagent closed; the owner reopens it to branch from its answer.
  const done = await threadsUntil(
    agent,
    (views) => views.some(({ id, closedBy }) => id === listed.id && closedBy === 'done'),
    15_000,
  )
  await ownerUpdate(agent, listed.id, { closed: false })
  const entry = (await answerIn(agent, listed.id)) ?? 0
  const branch = await ownerCreate(agent, { from: { conversation: listed.id, entry } })
  if (!branch.ok) return { branch }
  await exchange(agent, branch.value.id, 'what did you find?', 'subagent-branch-ask')
  // The subagent already offered `subagent`, so the thread's request lists only what it adds: use the tool instead.
  const status = await exchange(agent, branch.value.id, 'call subagent_status {}', 'subagent-branch-status')
  const subagentAfter = await listedThread(agent, listed.id)
  const closed = await ownerUpdate(agent, listed.id, { closed: true })
  return {
    doneClosed: done.find(({ id }) => id === listed.id),
    status,
    branch: branch.value,
    request: await agent.requestFor('what did you find?'),
    subagentAfter,
    closed,
    branchAfter: await listedThread(agent, branch.value.id),
    keepOpenThread: await ownerUpdate(agent, branch.value.id, { keepOpen: true }),
  }
}

/** Server-Sent Events from a response, one `{ event, data }` at a time, until `deadline` (ms since the epoch). */
async function* sseEvents(response: Response, deadline: number) {
  const reader = response.body?.getReader()
  if (reader === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))
      const read = await Promise.race([reader.read(), timeout])
      if (read === undefined || read.done) return
      buffer += decoder.decode(read.value, { stream: true })
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = /^event: (.*)$/mu.exec(frame)?.[1]
        const data = /^data: (.*)$/mu.exec(frame)?.[1]
        if (event === undefined || data === undefined) continue
        const value: unknown = JSON.parse(data)
        yield { event, data: value }
      }
    }
  } finally {
    await reader.cancel()
  }
}

/**
 * The workspace feed: a snapshot of every conversation first, then the changes as they land: a new thread, its run
 * working then idle (with its replies counted again), and its Close.
 */
async function feedSequence(agent: ProbeStub) {
  const events = sseEvents(await agent.fetch('https://agent/api/workspace/events'), Date.now() + 8000)
  const first = await events.next()
  const created = await ownerCreate(agent, {})
  if (!created.ok) return { created }
  const id = created.value.id
  await ownerSend(agent, id, 'Native slow job', 'feed-turn')
  const changes: unknown[] = []
  let stage: 'running' | 'reading' | 'closing' = 'running'
  for await (const { event, data } of events) {
    if (event !== 'change' || !Array.isArray(data)) continue
    changes.push(...data)
    const text = JSON.stringify(changes)
    if (stage === 'running' && text.includes('"state":"idle"') && text.includes('"replies":2')) {
      stage = 'reading'
      await ownerMarkRead(agent, id)
    }
    if (stage === 'reading' && text.includes('"readAt"')) {
      stage = 'closing'
      await ownerUpdate(agent, id, { closed: true })
    }
    if (stage === 'closing' && text.includes('"closedBy":"owner"')) break
  }
  return { snapshot: first.value, id, changes }
}

export const probes: Probes = {
  branch: inWorker(({ agent }) => branchSequence(agent)),
  share: inWorker(({ agent }) => shareSequence(agent)),
  announce: inWorker(({ agent }) => announceSequence(agent)),
  setups: inWorker(({ agent }) => setupSequence(agent)),
  subagent: inWorker(({ agent }) => subagentSequence(agent)),
  tree: inWorker(({ agent }) => treeSequence(agent)),
  'subagent-branch': inWorker(({ agent }) => subagentBranchSequence(agent)),
  feed: inWorker(({ agent }) => feedSequence(agent)),
}
