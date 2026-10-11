import { describe, expect, it } from 'vitest'
import { Conflict, GrantDenied, Internal, NeedsAuthorization, NotFound, UpstreamMcp } from '../src/http/errors.ts'
import { activationRefused } from '../src/routines/events.ts'

describe("an event routine's activation health (R4)", () => {
  it('asks the owner to act when the server, the grant or the selector refused it', () => {
    expect(activationRefused(new NeedsAuthorization({ connectionId: 'mygram' }))).toBe(true)
    expect(activationRefused(new GrantDenied({ connectionId: 'mygram', name: 'message.received' }))).toBe(true)
    expect(activationRefused(new NotFound({ what: 'server' }))).toBe(true)
    expect(activationRefused(new UpstreamMcp({ connectionId: 'mygram', reason: 'remote-rpc' }))).toBe(true)
  })

  it('keeps a transient failure out of the health message, so the routine stays activating', () => {
    expect(activationRefused(new UpstreamMcp({ connectionId: 'mygram', reason: 'transport' }))).toBe(false)
    expect(activationRefused(new Internal({ reason: 'unexpected' }))).toBe(false)
    expect(activationRefused(new Conflict({ reason: 'busy' }))).toBe(false)
    expect(activationRefused(new Error('socket hang up'))).toBe(false)
  })
})
