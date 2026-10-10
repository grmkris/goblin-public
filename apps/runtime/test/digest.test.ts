import { describe, expect, it } from 'vitest'
import { hex, isRecord, sha256Hex } from '../src/runtime/digest.ts'

describe('digest', () => {
  it('writes bytes as two lowercase hex digits each', () => {
    expect(hex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff')
    expect(hex(new Uint8Array([1, 2]).buffer)).toBe('0102')
  })

  it('hashes a string as its UTF-8 bytes, and bytes as they are', async () => {
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(await sha256Hex('abc')).toBe(abc)
    expect(await sha256Hex(new Uint8Array(new TextEncoder().encode('abc')))).toBe(abc)
    expect(await sha256Hex('é')).not.toBe(await sha256Hex('e'))
  })

  it('takes only an object of named fields as a record', () => {
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('a')).toBe(false)
  })
})
