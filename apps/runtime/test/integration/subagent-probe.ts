import { type ConversationView, MAIN_THREAD } from '@purrable/contracts'
import { exchange, threadsUntil, transcript, until } from './probe-reads.ts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

/** What the scripted model reads as a call of the `subagent` tool. */
const subagentCall = (args: { action: string; name: string; message?: string }) =>
  `call subagent ${JSON.stringify(args)}`

const named = (views: readonly ConversationView[], title: string) => views.find((view) => view.title === title)

/** A conversation's turns: its transcript without the memory views the builder places among them. */
const turnsOf = async (agent: Probe, session: string) =>
  (await transcript(agent, session)).filter((line) => !line.startsWith('app.memory'))

/** A conversation's turns once it has `count` reports from subagent `name` and has answered the last one. */
const reportsUntil = (agent: Probe, session: string, name: string, count = 1) =>
  until(
    () => turnsOf(agent, session),
    (lines) =>
      lines.filter((line) => line.includes(`[from subagent ${name}]`)).length >= count &&
      lines.at(-1)?.startsWith('pi.assistant') === true,
    20_000,
  )

/**
 * Main starts `lead`, which starts `digger` of its own. Main hears once, from lead, with lead's final answer (after
 * digger's report), never lead's "started digger". Both close as done; lead was offered subagents, not `ask_user`.
 */
export async function subagentChainSequence(agent: Probe): Promise<Response> {
  const inner = subagentCall({ action: 'spawn', name: 'digger', message: 'find deeper' })
  await exchange(agent, MAIN_THREAD, subagentCall({ action: 'spawn', name: 'lead', message: inner }), 'chain-spawn')
  const main = await reportsUntil(agent, MAIN_THREAD, 'lead')
  const views = await threadsUntil(
    agent,
    (all) => ['lead', 'digger'].every((title) => named(all, title)?.closedBy === 'done'),
    15_000,
  )
  const lead = named(views, 'lead')
  return Response.json({
    main,
    lead,
    digger: named(views, 'digger'),
    leadLines: lead === undefined ? [] : await transcript(agent, lead.id),
    leadRequest: await agent.requestFor(inner),
  })
}

/**
 * The owner writes to a busy subagent: the message steers its work, the answer reports up once, quoting the owner,
 * and the subagent stays open after its job (the owner engaged with it).
 */
export async function subagentOwnerSequence(agent: Probe): Promise<Response> {
  await exchange(
    agent,
    MAIN_THREAD,
    subagentCall({ action: 'spawn', name: 'scout', message: 'Native slow job' }),
    'owner-spawn',
  )
  const scout = named(await threadsUntil(agent, (views) => named(views, 'scout') !== undefined), 'scout')
  if (scout === undefined) return Response.json({ scout })
  const working = await until(
    () => agent.busy(scout.id),
    (busy) => busy,
  )
  const sent = await agent.submit(scout.id, 'also check the attic', 'owner-steer')
  const main = await reportsUntil(agent, MAIN_THREAD, 'scout')
  const settled = await agent.settle(scout.id, 'owner-steer')
  const after = named(await threadsUntil(agent, () => true), 'scout')
  return Response.json({ working, sent, settled, main, after, child: await transcript(agent, scout.id) })
}

/**
 * Stop reaches a subagent's own subagents and nothing reports the job cut short; Close shuts the subagent with what is
 * under it, and its spawner may not send to it then. A subagent closed because its job was done opens again for the
 * next message, reports, and closes again.
 */
export async function subagentCloseSequence(agent: Probe): Promise<Response> {
  const inner = subagentCall({ action: 'spawn', name: 'digger', message: 'Native slow job' })
  await exchange(agent, MAIN_THREAD, subagentCall({ action: 'spawn', name: 'lead', message: inner }), 'close-spawn')
  const views = await threadsUntil(agent, (all) => named(all, 'digger') !== undefined, 15_000)
  const lead = named(views, 'lead')
  const digger = named(views, 'digger')
  if (lead === undefined || digger === undefined) return Response.json({ views })
  const working = await until(
    () => agent.busy(digger.id),
    (busy) => busy,
  )
  const stopped = await exchange(agent, MAIN_THREAD, subagentCall({ action: 'stop', name: 'lead' }), 'close-stop')
  const diggerStopped = !(await agent.busy(digger.id))
  const closed = await agent.updateConversation(lead.id, { closed: true })
  const closedViews = await threadsUntil(agent, () => true)
  const refused = await exchange(
    agent,
    MAIN_THREAD,
    subagentCall({ action: 'send', name: 'lead', message: 'again' }),
    'close-refused',
  )
  await exchange(
    agent,
    MAIN_THREAD,
    subagentCall({ action: 'spawn', name: 'quick', message: 'find it' }),
    'close-quick',
  )
  const done = named(await threadsUntil(agent, (all) => named(all, 'quick')?.closedBy === 'done', 15_000), 'quick')
  const reopened = await exchange(
    agent,
    MAIN_THREAD,
    subagentCall({ action: 'send', name: 'quick', message: 'once more' }),
    'close-again',
  )
  const main = await reportsUntil(agent, MAIN_THREAD, 'quick', 2)
  const again = named(await threadsUntil(agent, (all) => named(all, 'quick')?.closedBy === 'done', 15_000), 'quick')
  return Response.json({
    working,
    stopped,
    diggerStopped,
    closed,
    lead: named(closedViews, 'lead'),
    digger: named(closedViews, 'digger'),
    refused,
    done,
    reopened,
    again,
    main,
    leadLines: await transcript(agent, lead.id),
    quickLines: done === undefined ? [] : await transcript(agent, done.id),
  })
}
