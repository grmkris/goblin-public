import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionLabels, labelOf } from '../../src/mcp/labels.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

const labels = () => {
  const database = chatDatabase()
  open.push(database)
  return new ConnectionLabels(durable(database.db))
}

describe('connection labels (SQLite)', () => {
  it('keeps one label per connection, unique whatever its case, and finds the next free one', () => {
    const store = labels()
    store.set('sidequest-1', 'Sidequest')
    expect(store.free('Sidequest')).toBe('Sidequest 2')
    store.set('sidequest-2', store.free('sidequest'))
    expect(store.all()).toEqual(
      new Map([
        ['sidequest-1', 'Sidequest'],
        ['sidequest-2', 'sidequest 2'],
      ]),
    )
    expect(() => store.set('sidequest-2', 'SIDEQUEST')).toThrow(expect.objectContaining({ reason: 'label_taken' }))
    store.set('sidequest-1', 'Sidequest · Hirer')
    expect(store.of('sidequest-1')).toBe('Sidequest · Hirer')
    store.remove('sidequest-1')
    expect(store.of('sidequest-1')).toBeUndefined()
  })

  it("gives configured connections their label once, keeping the owner's rename", () => {
    const store = labels()
    store.ensure([{ connectionId: 'myplan', endpoint: 'https://myplan.test/mcp', label: 'MyPlan' }])
    store.set('myplan', 'Plans')
    store.ensure([
      { connectionId: 'myplan', endpoint: 'https://myplan.test/mcp', label: 'MyPlan' },
      { connectionId: 'mybrowser', endpoint: 'https://mybrowser.test/mcp' },
    ])
    expect(store.all()).toEqual(
      new Map([
        ['myplan', 'Plans'],
        ['mybrowser', 'mybrowser'],
      ]),
    )
  })

  it('makes a label one line of at most eighty characters', () => {
    expect(labelOf('  Sidequest\n·   Hirer  ')).toBe('Sidequest · Hirer')
    expect(labelOf('x'.repeat(100))).toHaveLength(80)
  })
})
