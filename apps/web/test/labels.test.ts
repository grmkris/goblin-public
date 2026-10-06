import { describe, expect, it } from 'vitest'
import { eventStatus, serverStatus, serverTitle } from '../src/lib/labels.ts'

describe('labels', () => {
  it('says a server state in words, never the raw value', () => {
    expect(serverStatus('connected')).toEqual({ text: 'Connected', tone: 'good' })
    expect(serverStatus('needs_auth')).toEqual({ text: 'Needs sign-in', tone: 'attention' })
    expect(serverStatus('disconnected')).toEqual({ text: 'Not connected', tone: 'quiet' })
  })

  it('says an event subscription state in words, and an unknown one as paused', () => {
    expect(eventStatus('active').text).toBe('Receiving')
    expect(eventStatus('terminated')).toEqual({ text: 'Needs reconnecting', tone: 'attention' })
    expect(eventStatus('something_new')).toEqual({ text: 'Paused', tone: 'quiet' })
  })

  it('calls a server by its title, then its reported name, then its id', () => {
    expect(serverTitle({ serverId: 'board', title: 'Board', serverName: 'fixture-board' })).toBe('Board')
    expect(serverTitle({ serverId: 'board', serverName: 'fixture-board' })).toBe('fixture-board')
    expect(serverTitle({ serverId: 'board' })).toBe('board')
  })
})
