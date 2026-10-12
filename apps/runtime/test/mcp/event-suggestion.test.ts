import { describe, expect, it } from 'vitest'
import { type EventDescriptor, eventSuggestion } from '../../src/mcp/events/protocol.ts'

const descriptor = (extra: Partial<EventDescriptor>): EventDescriptor => ({
  name: 'mygram.message.received',
  inputSchema: {},
  delivery: ['poll', 'webhook'],
  ...extra,
})

describe("a server's suggestions for one event (ADR 0041)", () => {
  it('reads _meta["lol.mysi/suggest"] field by field, the title folded to one bounded line', () => {
    const suggestion = eventSuggestion(
      descriptor({
        title: 'Ignored when the suggestion has one',
        _meta: {
          'lol.mysi/suggest': {
            title: 'Message\nreceived\u0000',
            summary: 'A message reached your bot',
            group: 'Telegram',
            recommended: true,
            tellMe: true,
            rate: 'often',
          },
        },
      }),
    )
    expect(suggestion).toEqual({
      title: 'Message received',
      summary: 'A message reached your bot',
      group: 'Telegram',
      recommended: true,
      tellMe: true,
      rate: 'often',
    })
    expect(eventSuggestion(descriptor({ title: 'x'.repeat(500) })).title).toHaveLength(120)
  })

  it('drops only what is malformed, and reads nothing from a malformed _meta', () => {
    expect(
      eventSuggestion(
        descriptor({
          title: 'Question answered',
          _meta: { 'lol.mysi/suggest': { recommended: 'yes', rate: 'hourly', group: 7, tellMe: false } },
        }),
      ),
    ).toEqual({ title: 'Question answered', tellMe: false })
    expect(eventSuggestion(descriptor({ title: 42, _meta: ['not', 'an', 'object'] }))).toEqual({})
    expect(eventSuggestion(descriptor({ _meta: { 'lol.mysi/suggest': 'recommended' } }))).toEqual({})
  })
})
