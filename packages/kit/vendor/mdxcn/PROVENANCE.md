# mdxcn subset

Adapted from [shadcn-labs/mdxcn](https://github.com/shadcn-labs/mdxcn), `main` at
`16d817ad5ec54d89142e4c1cf26027b60d6df853` (read on 2026-10-06).
MIT, Copyright (c) 2026 Keshav Bagaade. The original notice is in [LICENSE](LICENSE).

Source files under `registry/default/`:

- `graph-timeline/graph-timeline.tsx` → `src/mdxcn-timeline.tsx`
- `graph-check/graph-check.tsx` → `src/mdxcn-check.tsx`
- `graph-compare/graph-compare.tsx` → `src/mdxcn-compare.tsx`
- `graph-stat/graph-stat.tsx` → `src/mdxcn-stat.tsx`
- `graph-spark/graph-spark.tsx` → `src/mdxcn-spark.tsx`
- `graph-frame/graph-frame.tsx` → `src/mdxcn-frame.tsx`
- `graph-frame/graph-motion.ts` → `src/mdxcn-motion.ts` and `src/kit.css`

Goblin keeps the data forms, checklist hierarchy, timeline states, comparison marks,
stat accents and spark glyphs. It supplies an Effect-validated JSON grammar, readonly
props, semantic comparison tables, readable screen-reader values, and pane-sized frames.
The MDX/Markdown child adapters, custom glyphs, palette controls and corner ornaments
are omitted. CSS implements the 220 ms cubic fade-up and capped stagger, with no animation
under reduced motion. Graph tokens map to Goblin's semantic and chart tokens locally;
there is no separate palette or new dependency.

The components are adapted source, subject to Goblin's ordinary quality checks.
