import { type ConversationView, PRIMARY_CHAT } from '@goblin/contracts'
import { exchange, ownerSend, ownerUpdate, threadsUntil, transcript, until } from './probe-reads.ts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

/** What the scripted model reads as a call of the subagent tool for `action`. */
const subagentCall = ({ action, ...args }: { action: string; name: string; message?: string; synthesize?: boolean }) =>
  `call subagent_${action} ${JSON.stringify(args)}`

const named = (views: readonly ConversationView[], title: string) => views.find((view) => view.title === title)

/** A conversation's turns: its transcript without the memory views the builder places among them. */
const turnsOf = async (agent: Probe, session: string) =>
  (await transcript(agent, session)).filter((line) => !line.startsWith('app.memory'))

/**
 * A conversation's turns once it has `count` reports from subagent `name`; with `answered`, once it has also answered
 * the last one. A passive Delegate result gets no answer, so after it the read waits a moment and reads again: a
 * Goblin run that wrongly followed would show.
 */
const reportsUntil = async (agent: Probe, session: string, name: string, count = 1, answered = false) => {
  const lines = await until(
    () => turnsOf(agent, session),
    (all) =>
      all.filter((line) => line.includes(`[from subagent ${name}]`)).length >= count &&
      (!answered || all.at(-1)?.startsWith('pi.assistant') === true),
    20_000,
  )
  if (answered) return lines
  await new Promise((resolve) => setTimeout(resolve, 600))
  return turnsOf(agent, session)
}

/**
 * Main starts `lead`, which starts `digger` of its own with `synthesize`, so lead answers digger's report. Main hears
 * once, from lead, with lead's final answer (after digger's report), never lead's "started digger", and does not answer
 * it. Both close as done; lead was offered subagents, not `ask_user`.
 */
export async function subagentChainSequence(agent: Probe): Promise<Response> {
  const inner = subagentCall({ action: 'spawn', name: 'digger', message: 'find deeper', synthesize: true })
  await exchange(agent, PRIMARY_CHAT, subagentCall({ action: 'spawn', name: 'lead', message: inner }), 'chain-spawn')
  const main = await reportsUntil(agent, PRIMARY_CHAT, 'lead')
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
    PRIMARY_CHAT,
    subagentCall({ action: 'spawn', name: 'scout', message: 'Native slow job' }),
    'owner-spawn',
  )
  const scout = named(await threadsUntil(agent, (views) => named(views, 'scout') !== undefined), 'scout')
  if (scout === undefined) return Response.json({ scout })
  const working = await until(
    () => agent.busy(scout.id),
    (busy) => busy,
  )
  const sent = await ownerSend(agent, scout.id, 'also check the attic', 'owner-steer')
  const main = await reportsUntil(agent, PRIMARY_CHAT, 'scout')
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
  await exchange(agent, PRIMARY_CHAT, subagentCall({ action: 'spawn', name: 'lead', message: inner }), 'close-spawn')
  const views = await threadsUntil(agent, (all) => named(all, 'digger') !== undefined, 15_000)
  const lead = named(views, 'lead')
  const digger = named(views, 'digger')
  if (lead === undefined || digger === undefined) return Response.json({ views })
  const working = await until(
    () => agent.busy(digger.id),
    (busy) => busy,
  )
  const stopped = await exchange(agent, PRIMARY_CHAT, subagentCall({ action: 'stop', name: 'lead' }), 'close-stop')
  const diggerStopped = !(await agent.busy(digger.id))
  const closed = await ownerUpdate(agent, lead.id, { closed: true })
  const closedViews = await threadsUntil(agent, () => true)
  const refused = await exchange(
    agent,
    PRIMARY_CHAT,
    subagentCall({ action: 'send', name: 'lead', message: 'again' }),
    'close-refused',
  )
  await exchange(
    agent,
    PRIMARY_CHAT,
    subagentCall({ action: 'spawn', name: 'quick', message: 'find it' }),
    'close-quick',
  )
  const done = named(await threadsUntil(agent, (all) => named(all, 'quick')?.closedBy === 'done', 15_000), 'quick')
  const reopened = await exchange(
    agent,
    PRIMARY_CHAT,
    subagentCall({ action: 'send', name: 'quick', message: 'once more' }),
    'close-again',
  )
  const main = await reportsUntil(agent, PRIMARY_CHAT, 'quick', 2)
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

/**
 * A Delegate's result is passive by default: main sees it in its transcript, attributed, and does not answer. With
 * `synthesize: true` the report is an input and main answers it exactly once. A nested Delegate without it posts its
 * result in its spawner's chat and the spawner does not answer either.
 */
export async function subagentSynthesisSequence(agent: Probe): Promise<Response> {
  await exchange(
    agent,
    PRIMARY_CHAT,
    subagentCall({ action: 'spawn', name: 'quiet', message: 'say little' }),
    'syn-quiet',
  )
  const passive = await reportsUntil(agent, PRIMARY_CHAT, 'quiet')
  await exchange(
    agent,
    PRIMARY_CHAT,
    subagentCall({ action: 'spawn', name: 'loud', message: 'say more', synthesize: true }),
    'syn-loud',
  )
  const both = await reportsUntil(agent, PRIMARY_CHAT, 'loud', 1, true)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const settled = await turnsOf(agent, PRIMARY_CHAT)
  const views = await threadsUntil(
    agent,
    (all) => ['quiet', 'loud'].every((title) => named(all, title)?.closedBy === 'done'),
    15_000,
  )
  return Response.json({ passive, both, settled, quiet: named(views, 'quiet'), loud: named(views, 'loud') })
}
