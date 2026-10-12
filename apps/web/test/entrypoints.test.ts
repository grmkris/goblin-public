import { describe, expect, it } from 'vitest'
import type { ServerView } from '@goblin/contracts'
import { entrypoints } from '../src/lib/entrypoints.ts'

const server = (overrides: Partial<ServerView>): ServerView => ({
  connectionId: 'wallet',
  label: 'Wallet',
  endpoint: 'https://wallet.goblin.surf/mcp',
  status: 'connected',
  live: true,
  source: 'config',
  ...overrides,
})

describe('the sidebar’s entrypoints', () => {
  it('lists a connected server with an entrypoint by its title, falling back to what the owner or the server calls it', () => {
    const listed = entrypoints([
      server({ entrypoint: 'wallet_open', title: 'Claimed title' }),
      server({ connectionId: 'b', label: 'B label', title: 'B title', entrypoint: 'home' }),
      server({ connectionId: 'c', label: 'C label', entrypoint: 'home' }),
    ])
    expect(listed).toEqual([
      { connectionId: 'wallet', title: 'Claimed title' },
      { connectionId: 'b', title: 'B title' },
      { connectionId: 'c', title: 'C label' },
    ])
  })
  it('leaves out a server without one, and one that is not connected', () => {
    expect(
      entrypoints([
        server({}),
        server({ connectionId: 'x', status: 'needs_auth', entrypoint: 'home' }),
        server({ connectionId: 'y', status: 'disconnected', entrypoint: 'home' }),
      ]),
    ).toEqual([])
  })
})
