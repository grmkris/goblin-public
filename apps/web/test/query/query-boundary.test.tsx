import { Conflict } from '@goblin/contracts/api'
import { use } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QueryBoundary, QueryError } from '../../src/lib/query/query-boundary.tsx'

describe('QueryBoundary', () => {
  it('renders its content, and its pending placeholder while a read suspends', () => {
    expect(
      renderToString(
        <QueryBoundary action="read your topics">
          <p>Topics</p>
        </QueryBoundary>,
      ),
    ).toContain('Topics')
    const wait = new Promise<never>(() => undefined)
    function Waiting(): never {
      return use(wait)
    }
    expect(
      renderToString(
        <QueryBoundary action="read your topics" pending={<p>Loading topics</p>}>
          <Waiting />
        </QueryBoundary>,
      ),
    ).toContain('Loading topics')
  })

  it('shows a failed read in place: its copy with the reference, and a retry', () => {
    const markup = renderToString(
      <QueryError
        error={new Conflict({ reason: 'stale', ref: '7f3a9c12e4b5-AMS' })}
        action="read your topics"
        onRetry={() => undefined}
      />,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('That clashes with something that is already there. · ref 7f3a9c12')
    expect(markup).toContain('Try again')
    expect(
      renderToString(<QueryError error={new TypeError('x')} action="read your topics" onRetry={() => undefined} />),
    ).toContain('Could not read your topics. Try again.')
  })
})
