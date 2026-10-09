import { QueryClientProvider } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentAppsQuery } from '../src/agent-apps/queries.ts'
import { AppsPage } from '../src/components/apps-page.tsx'
import { WorkspaceFeedProvider } from '../src/components/workspace-feed.tsx'
import { owner } from '../src/lib/api.ts'
import { testQueryClient } from '../src/lib/query/testing.ts'

/** What reached the network: the page reads what its route primed, and only an unprimed page reads for itself. */
const requests: string[] = []
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', (input: Request) => {
    requests.push(new URL(input.url).pathname)
    return new Promise<never>(() => undefined)
  })
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
})

const page = (client: ReturnType<typeof testQueryClient>) =>
  renderToString(
    <QueryClientProvider client={client}>
      <WorkspaceFeedProvider enabled={false}>
        <AppsPage />
      </WorkspaceFeedProvider>
    </QueryClientProvider>,
  )

describe('the Apps page', () => {
  it('shows the list its route primed, without reading it again', () => {
    const client = testQueryClient()
    client.setQueryData(agentAppsQuery.queryKey, [])
    const markup = page(client)
    expect(markup).toContain('No apps yet.')
    expect(requests).toEqual([])
  })

  it('waits on its placeholder while the list is still being read', () => {
    const markup = page(testQueryClient())
    expect(markup).toContain('data-slot="skeleton"')
    expect(markup).not.toContain('No apps yet.')
  })
})
