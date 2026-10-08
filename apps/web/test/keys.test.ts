import { expect, it } from 'vitest'
import { type KeyPress, sendsMessage } from '../src/lib/keys.ts'

const press = (extra: Partial<KeyPress> = {}): KeyPress => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...extra,
})

it('Enter sends at a keyboard and mouse; Shift+Enter breaks the line', () => {
  expect(sendsMessage(press(), false)).toBe(true)
  expect(sendsMessage(press({ shiftKey: true }), false)).toBe(false)
  expect(sendsMessage(press({ key: 'a' }), false)).toBe(false)
})

it('Return breaks the line on a touch screen; ⌘ or Ctrl+Enter still sends', () => {
  expect(sendsMessage(press(), true)).toBe(false)
  expect(sendsMessage(press({ metaKey: true }), true)).toBe(true)
  expect(sendsMessage(press({ ctrlKey: true }), true)).toBe(true)
})

it("an input method's Enter only composes", () => {
  expect(sendsMessage(press({ isComposing: true }), false)).toBe(false)
  expect(sendsMessage(press({ isComposing: true, metaKey: true }), true)).toBe(false)
})
