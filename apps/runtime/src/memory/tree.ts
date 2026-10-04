/**
 * The summary tree of main's memory, after OptChat (gist VictorTaelin/91837951a5ce5b38f341ec1ba1df6449, §3 and §5).
 * Node (level, index) covers messages [index·2^level, (index+1)·2^level): level 0 summarizes one message, a higher
 * node merges its two children. Pure: the builder (`memory.ts`) stores the nodes and calls the cheap model.
 */
export type Node = { readonly level: number; readonly index: number }

/** Target size of one summary line, in UTF-8 bytes. */
export const NODE_BYTES = 512
/** Size of the view main's model sees (OptChat uses 128 KB; Purrable keeps 48 KB). */
export const VIEW_BYTES = 48_000

const encoder = new TextEncoder()
export const byteLength = (text: string): number => encoder.encode(text).length

/** The first message a node covers. */
export const firstOf = (node: Node): number => node.index * 2 ** node.level
/** How many messages a node covers. */
export const spanOf = (node: Node): number => 2 ** node.level
/** A node's name in the view and for `zoom`: its first message and how many it covers, `id+n`. */
export const address = (node: Node): string => `${firstOf(node)}+${spanOf(node)}`
export const nodeKey = (node: Node): string => `${node.level}:${node.index}`
export const childrenOf = (node: Node): readonly [Node, Node] => [
  { level: node.level - 1, index: 2 * node.index },
  { level: node.level - 1, index: 2 * node.index + 1 },
]

/** The node `id+n` names: `n` a power of two and `id` a multiple of it; otherwise none. */
export function nodeAt(id: number, n: number): Node | undefined {
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(n) || id < 0 || n < 1) return undefined
  const level = Math.log2(n)
  if (!Number.isInteger(level) || id % n !== 0) return undefined
  return { level, index: id / n }
}

/** One view line: `id+n|text`, with the text's newlines as spaces. */
export const renderLine = (node: Node, text: string): string => `${address(node)}|${text.replaceAll(/\s*\n\s*/gu, ' ')}`

/** Bytes of a node's view line, from the bytes of its text: the address, the bar and the line end. */
const lineBytes = (node: Node, textBytes: number): number => address(node).length + 2 + textBytes

/** The text bytes of each built node, by `nodeKey`. */
export type Sizes = ReadonlyMap<string, number>

/** The view of messages [0, total): the parts in order, their bytes, and the merge it waits for when over budget. */
export type View = { readonly parts: readonly Node[]; readonly bytes: number; readonly wanted?: Node }

/** The adjacent pair to merge next: the most due, oldest relative to its size (OptMem's age rule). */
function mostDue(parts: readonly Node[], total: number): number | undefined {
  let best: number | undefined
  let bestDue = -1
  for (let at = 0; at + 1 < parts.length; at += 1) {
    const [a, b] = [parts[at], parts[at + 1]]
    if (a === undefined || b === undefined || a.level !== b.level || a.index % 2 !== 0 || b.index !== a.index + 1)
      continue
    const due = (total - firstOf(a)) / 2 ** (a.level + 2)
    if (due > bestDue) {
      best = at
      bestDue = due
    }
  }
  return best
}

/**
 * Merges the most due pairs of `parts` (in place) while they exceed `budget`, stopping at a pair whose parent is not
 * built: that parent is `wanted`. Returns the bytes after merging.
 */
function fit(parts: Node[], bytes: number, total: number, sizes: Sizes, budget: number) {
  const bytesOf = (node: Node) => lineBytes(node, sizes.get(nodeKey(node)) ?? 0)
  let size = bytes
  while (size > budget) {
    const at = mostDue(parts, total)
    const [a, b] = at === undefined ? [] : [parts[at], parts[at + 1]]
    if (at === undefined || a === undefined || b === undefined) return { bytes: size }
    const parent = { level: a.level + 1, index: a.index / 2 }
    if (!sizes.has(nodeKey(parent))) return { bytes: size, wanted: parent }
    parts.splice(at, 2, parent)
    size += bytesOf(parent) - bytesOf(a) - bytesOf(b)
  }
  return { bytes: size }
}

/**
 * Folds messages [0, total) into the view (OptChat §5.2): append each message's line, and while over `budget` merge
 * the most due adjacent pair. Merged parts never split, and the view changes near its end, so consecutive views share
 * their start. When the most due pair's parent is not built yet the fold stops merging and names it as `wanted`: the
 * builder makes only the merges the view needs. Every level-0 node below `total` must be built.
 */
export function fold(total: number, sizes: Sizes, budget = VIEW_BYTES): View {
  const parts: Node[] = []
  let fitted: { readonly bytes: number; readonly wanted?: Node } = { bytes: 0 }
  for (let message = 0; message < total; message += 1) {
    const leaf = { level: 0, index: message }
    parts.push(leaf)
    fitted = fit(parts, fitted.bytes + lineBytes(leaf, sizes.get(nodeKey(leaf)) ?? 0), message + 1, sizes, budget)
  }
  return { parts, ...fitted }
}
