import { describe, expect, it } from 'vitest'
import { bundleCarries, releaseBuild } from '../../scripts/build-id.ts'
import { repoRoot } from '../run.ts'

const BUILD = 'a'.repeat(40)
const PAGE =
  '<link rel="modulepreload" href="/assets/root-1.js"><script type="module" src="/assets/index-2.js"></script>'

/** A bundle as files by path, and the paths read from it in order. */
const bundle = (files: Readonly<Record<string, string>>) => {
  const reads: string[] = []
  const read = async (path: string): Promise<string> => {
    reads.push(path)
    return files[path] ?? ''
  }
  return { reads, read }
}

describe('releaseBuild', () => {
  it("is the checkout's full commit", () => {
    expect(releaseBuild(repoRoot)).toMatch(/^[0-9a-f]{40}$/u)
  })
})

describe('bundleCarries', () => {
  it('follows the chunks the page names and what they import until one carries the build', async () => {
    const { reads, read } = bundle({
      '/assets/root-1.js': 'import{a}from"./shared-3.js";',
      '/assets/index-2.js': 'import{b}from"./root-1.js";const c=()=>import("./lazy-4.js");',
      '/assets/shared-3.js': `const env={MODE:"production",VITE_GOBLIN_BUILD:\`${BUILD}\`};`,
    })
    await expect(bundleCarries(PAGE, BUILD, read)).resolves.toBe(true)
    expect(reads).toEqual(['/assets/root-1.js', '/assets/index-2.js', '/assets/shared-3.js'])
  })

  it('reads each chunk once and at most `limit` of them', async () => {
    const { reads, read } = bundle({
      '/assets/root-1.js': 'import"./index-2.js";import"./a-5.js";import"./b-6.js";',
      '/assets/index-2.js': 'import"./root-1.js";',
    })
    await expect(bundleCarries(PAGE, BUILD, read)).resolves.toBe(false)
    expect(reads).toEqual(['/assets/root-1.js', '/assets/index-2.js', '/assets/a-5.js', '/assets/b-6.js'])
    const limited = bundle({})
    await expect(bundleCarries(PAGE, BUILD, limited.read, 1)).resolves.toBe(false)
    expect(limited.reads).toEqual(['/assets/root-1.js'])
  })
})
