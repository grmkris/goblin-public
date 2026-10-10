import { DecisionProposal, EphemeralMessage } from '@goblin/contracts'
import {
  Conflict,
  DecisionsGroup,
  Internal,
  NotFound,
  OwnerAdmission,
  OwnerApi,
  ownerApiOf,
} from '@goblin/contracts/api'
import { MutationObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { labelDecisionMutation } from '../src/decisions/queries.ts'
import { labelOf, opensThread, proposalMessages } from '../src/decisions/rows.ts'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import { decodeChanges, decodeSnapshot } from '../src/lib/workspace/decode.ts'
import { applyChanges, fromSnapshot } from '../src/lib/workspace/slices.ts'
import { workspaceKeys, workspaceQueries, workspaceSync } from '../src/lib/workspace/sync.ts'

// Every fixture decodes with the contract schema the runtime answers with.
const proposal = (id: string, fields: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(DecisionProposal)({
    id,
    chatId: '1',
    kind: 'separate-work',
    subject: 'sha',
    payload: { type: 'thread-draft', title: 'Find flights to Kyoto in April' },
    state: 'open',
    probability: 0.8,
    provider: 'cloudflare/clef',
    createdAt: 10,
    ...fields,
  })
const report = (id: string, text: string, fields: Record<string, unknown> = {}) =>
  proposal(id, {
    kind: 'attention-triage',
    payload: { type: 'highlight', relayId: id.slice(10), text },
    provider: 'rules',
    probability: 0.6,
    ...fields,
  })
const source = (chat: string, excerpt: string, chatTitle?: string) => ({
  topic: 2,
  topicName: 'Garden',
  chat,
  ...(chatTitle !== undefined && { chatTitle }),
  entryStart: 11,
  entryEnd: 12,
  excerpt,
  retrievedAt: 5,
  score: -3,
})
const context = (id: string, sources: readonly ReturnType<typeof source>[], fields: Record<string, unknown> = {}) =>
  proposal(id, {
    kind: 'context-relevance',
    payload: { type: 'context', inputEntry: 7, sources },
    probability: 0.9,
    ...fields,
  })
const valid = Schema.decodeUnknownSync(Schema.Array(EphemeralMessage))
const EMPTY = { conversations: [], activity: [], apps: [] }

describe('decision proposals as owner-only rows', () => {
  it('shows each open proposal in its chat with its confirm and Dismiss, oldest first', () => {
    const rows = valid(
      proposalMessages([
        report('dp_report_7', 'The flat on Elm Street is available from May.', { chatId: '4', createdAt: 30 }),
        proposal('dp_thread_1_a'),
      ]),
    )
    expect(rows.map(({ id, chat }) => [id, chat])).toEqual([
      ['dp_thread_1_a', '1'],
      ['dp_report_7', '4'],
    ])
    expect(rows[0]).toMatchObject({
      title: 'This could be a thread',
      body: '“Find flights to Kyoto in April” looks like separate work. A new thread keeps it apart; nothing here moves.',
      actions: [
        { id: 'confirm', label: 'New thread', tone: 'primary' },
        { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
      ],
      createdAt: 10,
    })
    expect(rows[0]?.afterEntry).toBeUndefined()
    expect(rows[1]).toMatchObject({
      title: 'A report worth your attention',
      body: 'The flat on Elm Street is available from May.',
      actions: [{ id: 'confirm', label: 'Useful' }, { id: 'dismiss' }],
    })
  })

  it('quotes a long report once, on one line, cut after a whole word with an ellipsis', () => {
    const text = `Found it.\n\n${'Alfama flats under budget. '.repeat(20)}`
    const [row] = proposalMessages([report('dp_report_8', text)])
    const body = row?.body ?? ''
    expect(body.startsWith('Found it. Alfama flats under budget. Alfama')).toBe(true)
    expect(body.length).toBeLessThanOrEqual(280)
    expect(body).toMatch(/(?:Alfama|flats|under|budget\.)…$/u)
    expect(body).not.toContain('\n')
    expect(body.split('Found it.')).toHaveLength(2)
    const [long] = proposalMessages([report('dp_report_9', 'x'.repeat(400))])
    expect(long?.body).toBe(`${'x'.repeat(279)}…`)
  })

  it('shows nothing for a settled proposal, and only the newest thread suggestion of a chat', () => {
    const rows = proposalMessages([
      proposal('dp_thread_1_old', { createdAt: 5 }),
      proposal('dp_thread_1_new', { createdAt: 9 }),
      proposal('dp_thread_2_a', { chatId: '2', createdAt: 7 }),
      proposal('dp_thread_1_done', { state: 'confirmed', createdAt: 12 }),
      report('dp_report_1', 'Done.', { createdAt: 3 }),
      report('dp_report_2', 'Also done.', { createdAt: 4 }),
      report('dp_report_3', 'Gone.', { state: 'dismissed' }),
      report('dp_report_4', 'Old.', { state: 'stale' }),
    ])
    expect(rows.map(({ id }) => id)).toEqual(['dp_report_1', 'dp_report_2', 'dp_thread_2_a', 'dp_thread_1_new'])
  })

  it('offers earlier work from another chat with Use, naming where it is from and how many places', () => {
    const [one, many] = valid(
      proposalMessages([
        context('dp_context_1_a', [source('10', 'Raised beds need 30 cm of soil.', 'Beds')]),
        context(
          'dp_context_2_a',
          [source('10', 'Tomatoes need sun.'), source('11', 'Basil too.'), source('12', 'Water.')],
          { chatId: '2', createdAt: 11 },
        ),
      ]),
    )
    expect(one).toMatchObject({
      chat: '1',
      title: 'Earlier work may help here',
      body: 'From Garden · Beds: “Raised beds need 30 cm of soil.” Use gives goblin these excerpts with your next messages in this chat.',
      actions: [{ id: 'confirm', label: 'Use', tone: 'primary' }, { id: 'dismiss' }],
    })
    expect(many?.body).toContain('From Garden: “Tomatoes need sun.” And 2 more places.')
  })

  it('shows the newest thread and context suggestion of a chat side by side', () => {
    const rows = proposalMessages([
      context('dp_context_1_old', [source('10', 'Old.')], { createdAt: 5 }),
      proposal('dp_thread_1_new', { createdAt: 9 }),
      context('dp_context_1_new', [source('10', 'New.')], { createdAt: 9 }),
    ])
    expect(rows.map(({ id }) => id)).toEqual(['dp_thread_1_new', 'dp_context_1_new'])
  })

  it('reads an action as its label, and opens a thread only for a confirmed thread suggestion', () => {
    expect(labelOf('confirm')).toBe('confirm')
    expect(labelOf('dismiss')).toBe('dismiss')
    expect(labelOf('accept')).toBeUndefined()
    expect(opensThread(proposal('dp_thread_1_a', { state: 'confirmed' }))).toBe(true)
    expect(opensThread(proposal('dp_thread_1_a'))).toBe(false)
    expect(opensThread(proposal('dp_thread_1_a', { state: 'dismissed' }))).toBe(false)
    expect(opensThread(report('dp_report_1', 'Done.', { state: 'confirmed' }))).toBe(false)
    expect(opensThread(context('dp_context_1_a', [source('10', 'Soil.')], { state: 'confirmed' }))).toBe(false)
  })
})

/** The real decisions group served in memory: `dp_gone` is not there, `dp_stale` is stale, `dp_down` fails. */
const fakeOwner = () => {
  const Decisions = HttpApiBuilder.group(OwnerApi, 'decisions', (handlers) =>
    handlers.handle('label', ({ params, payload }) => {
      if (params.id === 'dp_report_gone') return Effect.fail(new NotFound({ what: 'decision proposal' }))
      if (params.id === 'dp_report_stale') return Effect.fail(new Conflict({ reason: 'stale' }))
      if (params.id === 'dp_report_down') return Effect.fail(new Internal({ reason: 'unexpected' }))
      const state = payload.label === 'confirm' ? 'confirmed' : 'dismissed'
      return Effect.succeed(report(params.id, 'Done.', { state, decidedAt: 20 }))
    }),
  )
  const gate = Layer.succeed(
    OwnerAdmission,
    OwnerAdmission.of((handler) => handler),
  )
  return fakeHttpApi(ownerApiOf(DecisionsGroup), Decisions.pipe(Layer.provide(gate)))
}

const fake = fakeOwner()
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

/** A cache whose feed's snapshot holds these open report highlights, and the label mutation over it. */
function labelling(...ids: string[]) {
  const client = testQueryClient()
  workspaceSync(client).snapshot({ ...EMPTY, proposals: ids.map((id) => report(id, 'Done.')) })
  const proposals = () => client.getQueryData(workspaceQueries.proposals.queryKey) ?? []
  const shown = () => proposals().map(({ id, state }) => [id, state])
  const rows = () => proposalMessages(proposals()).map(({ id }) => id)
  const status = () => client.getQueryData<string>(workspaceKeys.status) ?? ''
  return { label: new MutationObserver(client, labelDecisionMutation), shown, rows, status }
}

describe("the owner's label", () => {
  it('posts the label for the proposal and shows the proposal as the server answers it', async () => {
    const { label, shown } = labelling('dp_report_1', 'dp_report_2')
    const confirming = label.mutate({ id: 'dp_report_1', label: 'confirm' })
    expect(shown()).toEqual([
      ['dp_report_1', 'confirmed'],
      ['dp_report_2', 'open'],
    ])
    await expect(confirming).resolves.toMatchObject({ id: 'dp_report_1', state: 'confirmed', decidedAt: 20 })
    expect(fake.calls.at(-1)?.url).toContain('/api/decisions/dp_report_1')
    expect(fake.calls.at(-1)?.headers.get('x-goblin-csrf')).toBe('1')
    await label.mutate({ id: 'dp_report_2', label: 'dismiss' })
    expect(shown()).toEqual([['dp_report_1', 'confirmed']])
  })

  it('keeps a row that is gone or stale gone, and brings back one whose label failed otherwise', async () => {
    const { label, rows, status } = labelling('dp_report_gone', 'dp_report_stale', 'dp_report_down')
    await expect(label.mutate({ id: 'dp_report_gone', label: 'dismiss' })).rejects.toBeInstanceOf(NotFound)
    await expect(label.mutate({ id: 'dp_report_stale', label: 'confirm' })).rejects.toBeInstanceOf(Conflict)
    expect(status()).toBe('')
    expect(rows()).toEqual(['dp_report_down'])
    const failing = label.mutate({ id: 'dp_report_down', label: 'dismiss' })
    expect(rows()).toEqual([])
    await expect(failing).rejects.toBeInstanceOf(Internal)
    expect(rows()).toEqual(['dp_report_down'])
    expect(status()).not.toBe('')
  })
})

describe('proposals in the workspace feed', () => {
  it('keeps open and confirmed proposals from the snapshot, skipping one this tab cannot read', () => {
    const snapshot = decodeSnapshot({
      ...EMPTY,
      proposals: [
        report('dp_report_2', 'Later.', { createdAt: 20 }),
        { id: 'dp_future', kind: 'brief-update' },
        proposal('dp_thread_1_a', { state: 'confirmed' }),
        report('dp_report_3', 'Gone.', { state: 'dismissed' }),
      ],
    })
    expect(fromSnapshot(snapshot).proposals.map(({ id }) => id)).toEqual(['dp_thread_1_a', 'dp_report_2'])
    expect(fromSnapshot(decodeSnapshot(EMPTY)).proposals).toEqual([])
  })

  it('adds a new proposal, replaces one whose state changed, and drops it once dismissed or stale', () => {
    const start = fromSnapshot({ ...EMPTY, proposals: [proposal('dp_thread_1_a')] })
    const added = applyChanges(
      start,
      decodeChanges([
        { type: 'proposal', proposal: report('dp_report_1', 'Done.', { createdAt: 4 }) },
        { type: 'proposal', proposal: proposal('dp_thread_1_a', { state: 'confirmed', decidedAt: 12 }) },
      ]),
    )
    expect(added.proposals.map(({ id, state }) => [id, state])).toEqual([
      ['dp_report_1', 'open'],
      ['dp_thread_1_a', 'confirmed'],
    ])
    const settled = applyChanges(added, [
      { type: 'proposal', proposal: report('dp_report_1', 'Done.', { state: 'dismissed' }) },
      { type: 'proposal', proposal: proposal('dp_thread_1_b', { state: 'stale' }) },
    ])
    expect(settled.proposals.map(({ id }) => id)).toEqual(['dp_thread_1_a'])
    expect(proposalMessages(settled.proposals)).toEqual([])
  })
})
