import { describe, expect, it } from 'vitest'
import type { ServerProfile, ServerView } from '@goblin/contracts'
import { unconnectedProfiles } from '../src/components/connect-offer.tsx'

const profile = (id: string): ServerProfile => ({
  id,
  title: id,
  description: '',
  offer: 'so goblin can work',
  recommended: { run: [], ask: [] },
  status: false,
})

/** A connection as Connections lists it, signed in or not, with a first-class profile or none. */
const server = (connectionId: string, status: ServerView['status'], id?: string): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status,
  live: false,
  source: 'config',
  eventHealth: [],
  ...(id === undefined ? {} : { profile: profile(id) }),
})

describe('which first-class servers onboarding offers to connect (ADR 0043)', () => {
  it('offers a signed-out profile once, and none while another connection to it is signed in', () => {
    expect(
      unconnectedProfiles([
        server('mercator', 'connected', 'mercator'),
        server('mercator-2', 'disconnected', 'mercator'),
        server('cloudflare', 'needs_auth', 'cloudflare'),
        server('cloudflare-2', 'disconnected', 'cloudflare'),
        server('notes', 'disconnected'),
      ]).map((each) => each.connectionId),
    ).toEqual(['cloudflare'])
  })
})
