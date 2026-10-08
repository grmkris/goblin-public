export type VectorRecord = {
  readonly id: string
  readonly values: readonly number[]
  readonly metadata: Record<string, string | number>
}
export type VectorizeApi = {
  createIndex(name: string, dimensions: number): Promise<void>
  upsert(namespace: string, records: readonly VectorRecord[]): Promise<void>
  query(namespace: string, values: readonly number[], topK: number): Promise<readonly { id: string; score: number }[]>
  deleteIndex(name: string): Promise<void>
}
export type EmbeddingApi = { embed(texts: readonly string[], model: string): Promise<readonly (readonly number[])[]> }

/** A created scratch index is cleaned up even when a later embedding/upsert/query fails. */
export async function runVectorArm(
  api: VectorizeApi,
  embeddings: EmbeddingApi,
  excerpts: readonly { id: string; text: string }[],
  queries: readonly string[],
  config: { readonly model: string; readonly namespace: string },
) {
  const vectors = await embeddings.embed(
    excerpts.map((item) => item.text),
    config.model,
  )
  const dimensions = vectors[0]?.length ?? 0
  if (
    dimensions === 0 ||
    vectors.length !== excerpts.length ||
    vectors.some((vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))
  )
    throw new Error('Invalid embedding dimensions')
  await api.createIndex('goblin-spike-retrieval', dimensions)
  try {
    await api.upsert(
      config.namespace,
      excerpts.map((item, index) => ({ id: item.id, values: vectors[index] ?? [], metadata: { excerptId: item.id } })),
    )
    const queryVectors = await embeddings.embed(queries, config.model)
    if (queryVectors.length !== queries.length || queryVectors.some((vector) => vector.length !== dimensions))
      throw new Error('Invalid query embedding dimensions')
    const ranked = []
    for (const vector of queryVectors) ranked.push(await api.query(config.namespace, vector, 20))
    return { model: config.model, dimensions, ranked }
  } finally {
    await api.deleteIndex('goblin-spike-retrieval')
  }
}
