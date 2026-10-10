import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  ClientErrorReport,
  ConversationView,
  CreateConversation,
  FilePath,
  PersonaName,
  SendMessage,
  StartThread,
  UpdatePersona,
  WorkspaceChange,
  selectionKey,
} from './index.ts'

const ok = (path: string) => Schema.is(FilePath)(path)

describe('file paths', () => {
  it('accept plain names under the two areas', () => {
    expect(ok('/uploads/sales.csv')).toBe(true)
    expect(ok('/agent/reports/Poročilo (2).md')).toBe(true)
  })
  it('refuse other roots, dot segments, separators and empty segments', () => {
    expect(ok('/etc/passwd')).toBe(false)
    expect(ok('/uploads')).toBe(false)
    expect(ok('/uploads/../agent/x')).toBe(false)
    expect(ok('/uploads/./x')).toBe(false)
    expect(ok('/uploads//x')).toBe(false)
    expect(ok('/uploads/a\\b')).toBe(false)
    expect(ok('/uploads/a:b')).toBe(false)
  })
})

describe('topics, personas and threads', () => {
  const topic = {
    id: 2,
    name: 'Japan trip',
    conversation: '17',
    searchExcluded: false,
    revision: 1,
    setup: { mcpServers: [{ serverId: 'notes', tools: ['read'] }], skills: 'all', apps: [], subagents: false },
    createdBy: 'agent',
    createdAt: 1,
  }
  it('carries a Topic change through the workspace feed', () => {
    expect(Schema.decodeUnknownSync(WorkspaceChange)({ type: 'topic', topic })).toEqual({ type: 'topic', topic })
  })
  it('reads a conversation from a server older than Topics', () => {
    const old = { id: '1', kind: 'main', createdAt: 1, keepOpen: false, replies: 0 }
    expect(Schema.decodeUnknownSync(ConversationView)(old).topic).toBeUndefined()
  })
  it('names Personas as the composer tags them', () => {
    const named = Schema.is(PersonaName)
    expect(named('Scout')).toBe(true)
    expect(named('Code reviewer-2')).toBe(true)
    expect(named('2fast')).toBe(false)
    expect(named('@scout')).toBe(false)
    expect(named('x'.repeat(33))).toBe(false)
  })
  it('keys a Persona selection apart from other selections', () => {
    expect(selectionKey({ kind: 'persona', personaId: 3 })).toBe('persona:3')
  })
  it('refuses a Persona update without the revision it edits', () => {
    expect(Schema.is(UpdatePersona)({ name: 'Scout' })).toBe(false)
    expect(Schema.is(UpdatePersona)({ name: 'Scout', expectedRevision: 2 })).toBe(true)
  })
  it('bounds a message body like the messages route always did', () => {
    expect(Schema.is(SendMessage)({ input: 'hi', operationId: 'op-1', personaOrder: 'sequence' })).toBe(true)
    expect(Schema.is(SendMessage)({ input: 'x'.repeat(20_001), operationId: 'op-1' })).toBe(false)
  })
})

describe('thread operations', () => {
  it('keeps a create without an operation id valid and accepts one', () => {
    expect(Schema.is(CreateConversation)({ topic: 2 })).toBe(true)
    expect(Schema.is(CreateConversation)({ operationId: 'op-1', from: { conversation: '3', entry: 9 } })).toBe(true)
  })
  it('starts a thread from an entry, empty or the latest entry, with the message fields of a send', () => {
    const message = { input: 'hi', selections: [{ kind: 'persona', personaId: 3 }] }
    expect(Schema.is(StartThread)({ operationId: 'op-1', anchor: { entry: 9 }, message })).toBe(true)
    expect(Schema.is(StartThread)({ operationId: 'op-1', anchor: 'latest', message })).toBe(true)
    expect(Schema.is(StartThread)({ operationId: 'op-1', anchor: 'empty', message, personaOrder: 'sequence' })).toBe(
      true,
    )
    expect(Schema.is(StartThread)({ operationId: 'op-1', anchor: { entry: 0 }, message })).toBe(false)
    expect(Schema.is(StartThread)({ operationId: '', anchor: 'empty', message })).toBe(false)
  })
})

describe('client error reports', () => {
  const report = {
    route: '/c/$chatId',
    name: 'TypeError',
    frames: ['https://goblin.surf/assets/index-3f2a.js:1:2345'],
    build: 'd5ac526',
    ref: '7f3a9c12',
  }
  const valid = Schema.is(ClientErrorReport)
  it('accepts a route template, a class name, locations and a build', () => {
    expect(valid(report)).toBe(true)
  })
  it('refuses anything that could carry a message', () => {
    expect(valid({ ...report, name: 'Cannot read x of undefined' })).toBe(false)
    expect(valid({ ...report, route: '/c/1?q=my secret' })).toBe(false)
    expect(valid({ ...report, frames: ['at render (index.js:1:2)'] })).toBe(false)
    expect(valid({ ...report, frames: ['secret words'] })).toBe(false)
    expect(valid({ ...report, build: 'a b' })).toBe(false)
  })
  it('bounds the frames and the whole report', () => {
    expect(valid({ ...report, frames: Array.from({ length: 13 }, () => 'index.js:1:2') })).toBe(false)
    const long = `https://goblin.surf/${'a'.repeat(270)}.js:1:2`
    expect(valid({ ...report, frames: Array.from({ length: 12 }, () => long) })).toBe(false)
  })
})
