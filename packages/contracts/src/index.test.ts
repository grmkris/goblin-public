import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  ApiError,
  ConversationView,
  FilePath,
  PersonaName,
  SendMessage,
  UpdatePersona,
  WorkspaceChange,
  selectionKey,
} from './index.ts'

describe('contracts', () => {
  it('decodes the public error body and ignores unknown detail fields', () => {
    expect(Schema.decodeUnknownSync(ApiError)({ error: 'GrantDenied', serverId: 'myplan', name: 'x' })).toEqual({
      error: 'GrantDenied',
      serverId: 'myplan',
    })
  })
})

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
