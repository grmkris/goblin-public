import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { digest } from '../scripts/identity.ts'
import { RetrievalFixture, type TranscriptMessage, type RetrievalLabel } from '../src/retrieval-corpus.ts'

const generatedPath = fileURLToPath(new URL('../../.local/bench/retrieval/corpus.json', import.meta.url))
execFileSync('python3', [
  '-B',
  fileURLToPath(new URL('../scripts/retrieval/generate.py', import.meta.url)),
  '--output',
  generatedPath,
])
const raw = readFileSync(generatedPath)
export const fixtureSha256 = createHash('sha256').update(raw).digest('hex')
if (fixtureSha256 !== readFileSync(new URL('../fixtures/retrieval/corpus.sha256', import.meta.url), 'utf8').trim())
  throw new Error('generated fixture hash mismatch')

export const fixtureCorpus = () => Schema.decodeUnknownSync(RetrievalFixture)(JSON.parse(new TextDecoder().decode(raw)))
export const corpusHash = (messages: readonly TranscriptMessage[], labels: readonly RetrievalLabel[]) =>
  digest({ messages, labels })
