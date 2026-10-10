import * as HttpApi from 'effect/http-api/HttpApi'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { describe, expect, it } from 'vitest'
import { AccountApi } from './account.ts'
import { INTERNAL_PREFIX, InternalApi } from './internal.ts'
import { OwnerApi } from './owner.ts'

/** Every endpoint of `api` as `<METHOD> <path>`. */
const routesOf = <Id extends string, Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<Id, Groups>) => {
  const routes: string[] = []
  HttpApi.reflect(api, {
    onGroup: () => undefined,
    onEndpoint: ({ endpoint }) => void routes.push(`${endpoint.method} ${endpoint.path}`),
  })
  return routes
}
const pathOf = (route: string): string => route.slice(route.indexOf(' ') + 1)

// The Worker's edge forwards only `/api/*` for the owner and the agent refuses an internal path that came that way, so
// the two APIs must never share a path, nor an internal one leave its prefix.
describe('the owner and internal APIs', () => {
  it('keep their paths under their own prefixes, and share none', () => {
    const owner = routesOf(OwnerApi)
    const internal = routesOf(InternalApi)
    const account = routesOf(AccountApi)
    expect(owner.length).toBeGreaterThan(0)
    expect(internal.map(pathOf).toSorted()).toEqual([
      '/internal/ask',
      '/internal/doorbell',
      '/internal/inspect',
      '/internal/mcp-events',
      '/internal/recent',
    ])
    for (const route of [...owner, ...account]) expect(pathOf(route)).toMatch(/^\/api\//u)
    for (const route of internal) expect(pathOf(route).startsWith(`${INTERNAL_PREFIX}/`)).toBe(true)
    const internalPaths = new Set(internal.map(pathOf))
    expect([...owner, ...account].filter((route) => internalPaths.has(pathOf(route)))).toEqual([])
  })
})
