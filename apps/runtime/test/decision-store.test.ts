import type { DecisionProposal } from '@goblin/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addProposal,
  chosenContextProposal,
  decideProposal,
  listProposals,
  staleProposal,
  storedProposal,
} from '../src/decisions/store.ts'
import { appDecisionLabels } from '../src/storage/decision-schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const FENCE = { session: '1', epoch: 0 }
const proposal = (id: string, createdAt: number): DecisionProposal => ({
  id,
  chatId: '1',
  kind: 'attention-triage',
  subject: id,
  payload: { type: 'highlight', relayId: id, text: 'Done.' },
  state: 'open',
  probability: 0.6,
  provider: 'rules',
  createdAt,
})
const database = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  return db
}

describe('decision proposals in SQLite', () => {
  it('lists the newest 100 open and confirmed proposals, oldest first', () => {
    const db = database()
    for (let at = 1; at <= 105; at += 1) addProposal(db, proposal(`dp_report_${at}`, at), FENCE)
    decideProposal(db, 'dp_report_105', 'dismiss', 200)
    decideProposal(db, 'dp_report_104', 'confirm', 200)
    const listed = listProposals(db)
    expect(listed).toHaveLength(100)
    expect(listed[0]?.id).toBe('dp_report_5')
    expect(listed.at(-1)).toMatchObject({ id: 'dp_report_104', state: 'confirmed', decidedAt: 200 })
  })

  it('keeps the first label, says which writes changed it, and leaves a settled proposal settled', () => {
    const db = database()
    expect(addProposal(db, proposal('dp_report_1', 1), FENCE).changed).toBe(true)
    expect(addProposal(db, proposal('dp_report_1', 2), FENCE)).toMatchObject({
      changed: false,
      proposal: { createdAt: 1 },
    })
    expect(decideProposal(db, 'dp_report_1', 'confirm', 5)).toMatchObject({
      changed: true,
      proposal: { state: 'confirmed' },
    })
    expect(decideProposal(db, 'dp_report_1', 'dismiss', 6)).toMatchObject({
      changed: false,
      proposal: { state: 'confirmed' },
    })
    expect(staleProposal(db, 'dp_report_1', 7)).toMatchObject({ changed: false, proposal: { state: 'confirmed' } })
    expect(db.select().from(appDecisionLabels).all()).toEqual([
      {
        proposalId: 'dp_report_1',
        label: 'confirm',
        judgedAt: 5,
        kind: 'attention-triage',
        provider: 'rules',
        probability: 0.6,
      },
    ])
    expect(storedProposal(db, 'dp_report_1')?.fence).toEqual(FENCE)
    expect(decideProposal(db, 'dp_none', 'confirm', 8)).toBeUndefined()
    expect(staleProposal(db, 'dp_none', 8)).toBeUndefined()
  })

  it("finds a chat's newest context proposal confirmed since a time", () => {
    const db = database()
    const source = {
      topic: 2,
      topicName: 'Garden',
      chat: '10',
      entryStart: 11,
      entryEnd: 12,
      excerpt: 'Raised beds need 30 cm of soil.',
      retrievedAt: 1,
      score: -2,
    }
    const context = (id: string): DecisionProposal => ({
      ...proposal(id, 1),
      kind: 'context-relevance',
      payload: { type: 'context', inputEntry: 2, sources: [source] },
    })
    addProposal(db, context('dp_context_1_a'), FENCE)
    addProposal(db, context('dp_context_1_b'), FENCE)
    decideProposal(db, 'dp_context_1_a', 'confirm', 100)
    decideProposal(db, 'dp_context_1_b', 'confirm', 150)
    expect(chosenContextProposal(db, '1', 90)?.id).toBe('dp_context_1_b')
    expect(chosenContextProposal(db, '1', 160)).toBeUndefined()
    expect(chosenContextProposal(db, '2', 0)).toBeUndefined()
  })
})
