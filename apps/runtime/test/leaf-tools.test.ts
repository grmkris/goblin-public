import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { filesExtension } from '../src/pi/files.ts'
import { homeExtension } from '../src/pi/home.ts'
import type { RunProgram } from '../src/pi/resident-mcp.ts'
import { serversExtension } from '../src/pi/servers.ts'
import { skillsExtension } from '../src/pi/skills.ts'
import { threadExtension } from '../src/pi/thread.ts'
import { ReadyResult } from '../src/pi/typed-tool.ts'

type Arguments = Parameters<typeof validateToolArguments>[1]['arguments']

/** A runner that answers each program with the next of `answers`, whatever the program is. */
function runner(...answers: unknown[]): RunProgram {
  // SAFETY: each test queues the value the tool's program returns.
  return <A>() => Promise.resolve(answers.shift() as A)
}

function tool(extension: Extension, name: string): ToolRegistration {
  const found = extension.tools?.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`${name} missing`)
  return found
}

const call = (registration: ToolRegistration, args: Arguments) => {
  const checked = validateToolArguments(registration, {
    type: 'toolCall',
    id: 'tc_1',
    name: registration.name,
    arguments: args,
  })
  // SAFETY: these tools read only the conversation and call ids of the API, and none of the context.
  return registration.execute(checked, { conversationId: 3, callId: 'tc_1' } as never, {} as never)
}

const layout = {
  revision: 2,
  tiles: [{ id: 't1', size: 'medium', kind: 'note', title: 'Hi', markdown: 'x', placedBy: 'owner' }],
}
const edit = { operationId: 'op1', expectedRevision: 2, ops: [{ kind: 'remove', id: 't1' }] }

describe('leaf tools (unit, ADR 0027)', () => {
  it('home_edit asks the owner about their tiles and ends the turn, and receipts an applied edit', async () => {
    const asked = await call(
      tool(homeExtension(runner({ kind: 'owner-required', layout, tileIds: ['t1'] })), 'home_edit'),
      edit,
    )
    expect(asked.control).toEqual({ terminate: true })
    expect(asked.details).toMatchObject({ kind: 'home-owner-required', edit })
    expect(JSON.stringify(asked.content)).toContain('May I change these owner-placed Home tiles?')

    const applied = { kind: 'applied', operationId: 'op1', layout, tileIds: ['t1'], message: 'Removed a note.' }
    const done = await call(tool(homeExtension(runner(applied)), 'home_edit'), edit)
    expect(done.control).toBeUndefined()
    expect(done.details).toMatchObject({
      kind: 'home-receipt',
      operationId: 'op1',
      tileIds: ['t1'],
      message: 'Removed a note.',
    })

    // Undo is the owner's: the agent's edit drops `undoOf`.
    const owner = { kind: 'owner-required', layout, tileIds: ['t1'] }
    const undo = await call(tool(homeExtension(runner(owner)), 'home_edit'), { ...edit, undoOf: 'op0' })
    expect(undo.details).toMatchObject({ edit })
    expect(JSON.stringify(undo.details)).not.toContain('undoOf')
  })

  it('files_read returns a part of the text and where the next one starts', async () => {
    const entry = { path: '/agent/a.md', name: 'a.md', kind: 'file', size: 9, mimeType: 'text/markdown', updatedAt: 1 }
    const read = await call(tool(filesExtension(runner({ entry, text: 'hello', next: 5 })), 'files_read'), {
      path: '/agent/a.md',
      offset: null,
    })
    expect(read.details).toEqual({ structuredContent: { entry, text: 'hello', next: 5 } })
  })

  it('share_back says where the note went', async () => {
    const shared = await call(tool(threadExtension(runner(undefined, '12')), 'share_back'), {
      note: 'the word is lantern',
    })
    expect(shared.content).toEqual([{ type: 'text', text: 'Shared with 12.' }])
    expect(shared.details).toEqual({ structuredContent: { sharedWith: '12' } })
  })

  it('skill_activate shows the verified skill in its tags, and skill_read returns an image as content as it is', async () => {
    const loaded = { handle: 'lib:review', origin: 'lib', body: '# Review\n', files: [{ path: 'a.md', size: 3 }] }
    const activated = await call(tool(skillsExtension(runner(loaded)), 'skill_activate'), { skill: 'lib:review' })
    expect(activated.content).toEqual([
      {
        type: 'text',
        text: '<skill handle="lib:review" origin="lib">\n\n# Review\n\n</skill>\n\nFiles you may read with skill_read: a.md (3 bytes)',
      },
    ])
    expect(activated.details).toEqual({ structuredContent: loaded })

    const image = { content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }] }
    const read = await call(tool(skillsExtension(runner(new ReadyResult(image))), 'skill_read'), {
      skill: 'lib:review',
      path: 'a.png',
    })
    expect(read).toEqual(image)
  })

  it('mcp_suggest returns what it found as untrusted data', async () => {
    const found = {
      trusted: false,
      suggested: [],
      registries: [
        {
          name: 'Weather',
          endpoint: 'https://w.example/mcp',
          registry: 'Official',
          verified: true,
          needsKey: false,
          added: false,
        },
      ],
    }
    const suggested = await call(tool(serversExtension(runner(found), undefined), 'mcp_suggest'), { query: 'weather' })
    expect(suggested.details).toEqual({ structuredContent: found })
    expect(suggested.content).toEqual([{ type: 'text', text: JSON.stringify(found) }])
  })
})
