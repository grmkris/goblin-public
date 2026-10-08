import { Schema } from 'effect'
export type Candidate = { readonly id: string; readonly text: string; readonly score: number }
export type Reranker = (query: string, candidates: readonly Candidate[]) => Promise<unknown>
const Result = Schema.Struct({ ids: Schema.Array(Schema.String), none: Schema.Boolean })

/** Reject invented, duplicate or contradictory citations; preserve provider output instead of repairing it. */
export async function rerankTop20(query: string, candidates: readonly Candidate[], reranker: Reranker) {
  const top = candidates.slice(0, 20)
  const started = performance.now()
  const selected = Schema.decodeUnknownSync(Result)(await reranker(query, top))
  const allowed = new Set(top.map((candidate) => candidate.id))
  if (
    selected.none !== (selected.ids.length === 0) ||
    new Set(selected.ids).size !== selected.ids.length ||
    selected.ids.some((id) => !allowed.has(id))
  )
    throw new Error('Invalid rerank candidate selection')
  return { ids: selected.ids, latencyMs: performance.now() - started, candidates: top.length }
}
