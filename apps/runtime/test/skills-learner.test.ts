import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import type { ConversationId } from '@earendil-works/pi-durable'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpHost } from '../src/mcp/host.ts'
import { SkillLearner } from '../src/skills/learner.ts'
import { SkillLibrary } from '../src/skills/library.ts'
import { SKILLS_EXTENSION } from '../src/skills/protocol.ts'
import { MemoryCredentials, MemoryGrants } from './mcp/memory.ts'
import { MemoryDraftLog, MemorySkillState } from './skills-memory.ts'

/** What the library fixture received and answers: drafts in order, and the status it reports for each. */
const library: { drafts: Record<string, unknown>[]; status: 'open' | 'accepted' | 'rejected' } = {
  drafts: [],
  status: 'open',
}
const AnyParams = Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown))
const skills = createMcpHandler(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK Server keeps this fixture's lists exact.
  const server = new Server(
    { name: 'library', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION]: {} } } },
  )
  server.setRequestHandler('skills/list', { params: AnyParams }, () => ({ skills: [], ttlMs: 60_000 }))
  server.setRequestHandler('resources/list', () => ({ resources: [] }))
  server.setRequestHandler('tools/list', () => ({
    tools: [
      { name: 'skill_draft', inputSchema: { type: 'object', properties: {} } },
      { name: 'skill_draft_status', inputSchema: { type: 'object', properties: {} } },
    ],
  }))
  server.setRequestHandler('tools/call', (request) => {
    if (request.params.name === 'skill_draft') {
      library.drafts.push(request.params.arguments ?? {})
      const draftId = `draft-${library.drafts.length}`
      return { content: [], structuredContent: { draftId, status: 'open' } }
    }
    const draftId = String(request.params.arguments?.['draftId'])
    return { content: [], structuredContent: { draftId, status: library.status } }
  })
  return server
})

/** The latest exchange of the conversation, as Pi entries newest first. */
let exchange: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[] = []
const harness = {
  pi: async () => ({
    conversation: async () => ({
      entries: async () => ({
        items: exchange
          .map((message, at) => ({
            id: at,
            kind: message.role === 'user' ? 'pi.user' : 'pi.assistant',
            model: [{ role: message.role, content: [{ type: 'text', text: message.text }] }],
          }))
          .toReversed(),
        next: undefined,
      }),
    }),
  }),
}
/** The cheap model's answer, and how many times it was asked. */
const model = { answer: '{"action":"none"}', calls: 0 }

let clock = 10_000_000
const state = new MemorySkillState()
const credentials = new MemoryCredentials()
await credentials.saveTokens('lib', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
const grants = new MemoryGrants()
const host = new McpHost({
  servers: [{ serverId: 'lib', endpoint: 'https://library.test/mcp' }],
  credentials,
  grants,
  skillsEnabled: (serverId) => state.enabled(serverId),
  appUrl: 'https://purrable.test',
  fetch: async (input, init) => skills.fetch(new Request(input, init)),
})
let drafts = new MemoryDraftLog()
const learner = () =>
  new SkillLearner({
    drafts,
    // SAFETY: the learner only reads `pi().conversation().entries()`, which this fixture answers.
    harness: harness as never,
    manager: host.manager,
    library: new SkillLibrary(host.manager, state, () => clock),
    state,
    // SAFETY: the learner only calls `complete`, which this fixture answers.
    model: {
      complete: async () => {
        model.calls += 1
        return model.answer
      },
    } as never,
    allows: (serverId, name) => grants.allows({ serverId, capability: 'tool', name }),
    now: () => clock,
  })
// SAFETY: Pi conversation ids are numbers; the fixture harness ignores which one is asked for.
const MAIN = 0 as ConversationId

const NEW_SKILL = JSON.stringify({
  action: 'new',
  name: 'weekly-review',
  description: 'Review the week: blocked tasks first, then decisions that changed.',
  body: '1. List blocked tasks first.\n2. Then decisions that changed since last week.\nAsk ana@example.com if unsure.',
  evidence: 'The owner said the review must start with blocked tasks.',
})

beforeEach(() => {
  library.drafts = []
  library.status = 'open'
  model.calls = 0
  model.answer = '{"action":"none"}'
  drafts = new MemoryDraftLog()
  state.setEnabled('lib', true)
  for (const name of ['skill_draft', 'skill_draft_status'])
    grants.set({ serverId: 'lib', capability: 'tool', name }, true)
  exchange = [
    { role: 'user', text: 'Do the weekly review.' },
    { role: 'assistant', text: 'Here is the review: decisions first.' },
    { role: 'user', text: 'No, next time always start with the blocked tasks.' },
    { role: 'assistant', text: 'Understood, blocked tasks first.' },
  ]
})
afterEach(async () => {
  await host.manager.closeAll()
})

describe('the skill learner (unit)', () => {
  it('asks the model nothing when the owner neither corrected nor asked to keep anything', async () => {
    exchange = [
      { role: 'user', text: 'Thanks, that is great.' },
      { role: 'assistant', text: 'Glad it helped.' },
    ]
    expect(await learner().consider(MAIN)).toBe('skipped')
    expect(model.calls).toBe(0)
  })

  it('drafts nothing when the model finds no procedure', async () => {
    expect(await learner().consider(MAIN)).toBe('none')
    expect(model.calls).toBe(1)
    expect(library.drafts).toEqual([])
  })

  it('proposes a new skill draft without private details, and never the same draft twice', async () => {
    model.answer = `Sure. ${NEW_SKILL}`
    expect(await learner().consider(MAIN)).toBe('drafted')
    expect(library.drafts).toHaveLength(1)
    // SAFETY: the learner sends these fields; the assertions below fail if it does not.
    const sent = library.drafts[0] as { files: { path: string; text: string }[]; name: string; operationId: string }
    expect(sent.name).toBe('weekly-review')
    expect(sent.operationId).toMatch(/^learn-[0-9a-f]{32}$/u)
    const text = sent.files[0]?.text ?? ''
    expect(text).toMatch(/^---\nname: weekly-review\ndescription: "Review the week/u)
    expect(text).toContain('List blocked tasks first.')
    expect(text).not.toContain('ana@example.com')
    // The same lesson again, while the first draft waits for review: no second draft.
    expect(await learner().consider(MAIN)).toBe('duplicate')
    expect(library.drafts).toHaveLength(1)
  })

  it('does not propose a rejected draft again', async () => {
    model.answer = NEW_SKILL
    expect(await learner().consider(MAIN)).toBe('drafted')
    library.status = 'rejected'
    expect(await learner().consider(MAIN)).toBe('duplicate')
    expect([...drafts.rows.values()].map((row) => row.status)).toEqual(['rejected'])
    expect(library.drafts).toHaveLength(1)
  })

  it('stays quiet when the owner has not allowed the draft tool, or skills are off', async () => {
    model.answer = NEW_SKILL
    grants.set({ serverId: 'lib', capability: 'tool', name: 'skill_draft' }, false)
    expect(await learner().consider(MAIN)).toBe('skipped')
    grants.set({ serverId: 'lib', capability: 'tool', name: 'skill_draft' }, true)
    state.setEnabled('lib', false)
    expect(await learner().consider(MAIN)).toBe('skipped')
    expect(model.calls).toBe(0)
  })

  it('proposes at most five drafts a day', async () => {
    for (let n = 0; n < 5; n++) {
      model.answer = NEW_SKILL.replace('weekly-review', `review-${n}`)
      expect(await learner().consider(MAIN)).toBe('drafted')
    }
    model.answer = NEW_SKILL.replace('weekly-review', 'review-5')
    expect(await learner().consider(MAIN)).toBe('skipped')
    clock += 86_400_001
    expect(await learner().consider(MAIN)).toBe('drafted')
  })
})
