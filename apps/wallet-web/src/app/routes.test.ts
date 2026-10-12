import { describe, expect, it } from 'vitest'
import { routeOf } from './routes.ts'

describe('routeOf', () => {
  it('names every console page, with or without a trailing slash', () => {
    for (const page of ['activity', 'limits', 'connections', 'add-funds'] as const) {
      expect(routeOf(`/${page}`)).toEqual({ page })
      expect(routeOf(`/${page}/`)).toEqual({ page })
      expect(routeOf(`/${page}//`)).toEqual({ page })
    }
    expect(routeOf('/')).toEqual({ page: 'home' })
  })

  it('names the pages the owner lands on from outside', () => {
    expect(routeOf('/setup')).toEqual({ page: 'setup' })
    expect(routeOf('/consent/')).toEqual({ page: 'consent' })
    expect(routeOf('/approve/op_pending%2F01')).toEqual({ page: 'approve', operationId: 'op_pending/01' })
    expect(routeOf('/approve/op%E0%A4%A')).toEqual({ page: 'approve', operationId: 'op%E0%A4%A' })
  })

  it('sends anything else Home', () => {
    for (const path of ['/nope', '/approve/', '/activity/extra', '/SETUP'])
      expect(routeOf(path)).toEqual({ page: 'home' })
  })
})
