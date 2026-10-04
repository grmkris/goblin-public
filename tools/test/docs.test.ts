import { expect, test } from 'vitest'
import { unknownCommands } from '../docs.ts'

test('documentation fails on an undeclared root command', () => {
  expect(unknownCommands('Use `bun run invented:gate`.', new Set(['check']))).toEqual(['invented:gate'])
  expect(unknownCommands('Use `bun run check`.', new Set(['check']))).toEqual([])
})
