import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Schema } from 'effect'
import { expect, test } from 'vitest'
import { Corpus } from '../src/corpus.ts'
import { importClaude, sourceCheckpoints } from '../src/import.ts'
import { publicEvents } from '../src/protocol.ts'
import { replayGroups } from '../worker/replay.ts'
import { episodes } from '../src/plan.ts'
import { validateManifest, starterManifest } from '../src/manifest.ts'
import { redactor } from '../scripts/redaction.ts'
import { scoreProbe } from '../src/scoring.ts'

const dir = resolve(import.meta.dirname, '../../.local/bench/corpora/purrable-claude-canary')
const sourcePath = resolve(dir, 'source.jsonl')
// Optional private regression uses the actual frozen session. CI never substitutes a generated conversation.
test.skipIf(!existsSync(sourcePath))(
  'real Claude source: visible blocks, parallel calls, checkpoint pairs and host-only labels',
  () => {
    const source = readFileSync(sourcePath, 'utf8')
    const imported = importClaude(source, redactor([]).redact)
    expect(imported.events).toHaveLength(1015)
    expect(imported.events.filter((event) => event.kind === 'tool-call')).toHaveLength(425)
    expect(imported.events.filter((event) => event.kind === 'tool-result')).toHaveLength(425)
    const checkpoints = sourceCheckpoints(imported.events, [16_000, 32_000])
    expect(checkpoints.map((checkpoint) => checkpoint.cutoff)).toEqual([22, 32])
    const corpus = Schema.decodeUnknownSync(Corpus)(JSON.parse(readFileSync(resolve(dir, 'corpus.json'), 'utf8')))
    const scenario = corpus.scenarios[0]
    if (scenario === undefined) throw new Error('Missing imported scenario')
    const manifest = {
      ...starterManifest(),
      scenarioIds: [scenario.id],
      variants: starterManifest().variants.slice(0, 6),
    }
    expect(episodes(manifest, [scenario])).toHaveLength(36)
    expect(
      validateManifest({ ...manifest, allowance: { ...manifest.allowance, maxAnswers: 35 } }, [scenario]),
    ).toContain('answer plan exceeds allowance')
    const groups = replayGroups(publicEvents(scenario.events.slice(0, 32)))
    expect(groups.length).toBeLessThan(32)
    const parallel = groups.find((group) => group.ids.includes('claude.l96.b0'))
    expect(parallel?.ids).toEqual(['claude.l96.b0', 'claude.l97.b0'])
    const message = parallel?.entry.model?.[0]
    if (message?.role !== 'assistant') throw new Error('Missing replay assistant')
    expect(message.content.filter((block) => block.type === 'toolCall').map((block) => block.arguments)).toEqual(
      scenario.events.filter((event) => parallel?.ids.includes(event.id)).map((event) => event.arguments),
    )
    expect(JSON.stringify(publicEvents(scenario.events))).not.toContain('requiredClaims')
    const probe = scenario.probes[0]
    if (probe === undefined) throw new Error('Missing grounded probe')
    expect(scoreProbe(scenario, probe, { claims: [], evidenceIds: [], abstain: false }, []).correct).toBe(false)
    const truncated = source.split('\n').slice(0, 28).join('\n')
    expect(() => importClaude(truncated, (text) => text)).toThrow('unmatched tool calls')
    expect(() => importClaude('{broken JSON}', (text) => text)).toThrow()
  },
)
