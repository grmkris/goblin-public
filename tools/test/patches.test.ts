import { expect, test } from 'vitest'
import { checkPatch, markerOf, type PatchSpec } from '../patches.ts'

const spec: PatchSpec = {
  key: '@scope/pkg@1.2.3',
  entry: '@scope/pkg/part',
  from: 'packages/x/src',
  source: 'patches/pkg/part.diff',
}
const source = new TextEncoder().encode('diff --git a/x b/x\n')
const head = (marker: string) => `"use client";\n${marker}\nimport * as React from 'react';\n`

test('the marker names the package, its version, the recipe and the hash of the diff it was built from', () => {
  expect(markerOf(spec, source)).toMatch(/^\/\/ @scope\/pkg 1\.2\.3 \+ purrable patches\/pkg [0-9a-f]{12}$/u)
})

test('an installed patch built from the current diff passes', () => {
  expect(checkPatch(spec, { version: '1.2.3', head: head(markerOf(spec, source)) }, source)).toEqual([])
})

test('a skipped patch fails: the unpatched file has no marker', () => {
  const [failure] = checkPatch(spec, { version: '1.2.3', head: '"use client";\nimport {c}from"../chunk.js"' }, source)
  expect(failure).toContain('lacks')
})

test('a patch built from an older diff fails', () => {
  const stale = markerOf(spec, new TextEncoder().encode('older'))
  expect(checkPatch(spec, { version: '1.2.3', head: head(stale) }, source)).toHaveLength(1)
})

test('another installed version fails, since bun would skip the patch for it', () => {
  const [failure] = checkPatch(spec, { version: '1.2.4', head: head(markerOf(spec, source)) }, source)
  expect(failure).toContain('1.2.4 is installed')
})

test('a module that does not resolve fails', () => {
  expect(checkPatch(spec, undefined, source)).toHaveLength(1)
})
