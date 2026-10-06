# ADR 0023: Chat blocks, one kit

Accepted 2026-10-06 with the owner, as part of the agent apps plan. goblin's chat did not draw Mermaid; agent apps
will need diagrams, charts and maps too, in goblin's design language.

**Fenced blocks.** The agent's replies draw ```mermaid, ```chart, ```map and ```mdxcn fenced blocks. A chart is JSON: a type
(line, bar, area, pie), a category key `x`, up to five series and up to 500 rows. A map is JSON: markers and lines in
latitude/longitude, or a center and zoom; it fits whatever it holds. Everything else stays a code block, and so does
a block whose source does not parse or fails to draw: model output is untrusted, so a block can never break a
message. While a reply streams, the block whose fence is still open stays code until it is whole.

**Curated mdxcn figures.** A ```mdxcn fence contains one JSON object with a required `kind` and `title`:
`timeline` (`events`: date, label, optional done/now/next state and note), `check` (`items`: label, optional done,
note and nested items), `compare` (`columns` and labelled `rows` with values), `stat` (`items`: label, value,
optional hint and accent), or `spark` (`data` and optional caption). Effect validates the union before drawing:
32,768 characters per source; titles, labels and dates 1–120 characters; notes, hints, captions and comparison
strings at most 240; stat value strings at most 64. Lists are bounded: 32 events; 20 checks per list, three levels
and 64 checks total; 2–4 distinct comparison columns, 1–24 rows with exactly one string/number/boolean value per
column; 1–8 stats; 2–64 non-negative finite spark values up to 1e12. Unknown kinds, extra fields and invalid data
remain the original code. Only assistant replies draw mdxcn; tool Markdown and shared notes keep it as code.
The persona describes the grammar and asks for at most two figures per reply.

**One kit.** `packages/kit` (`@goblin/kit`) is the one implementation: the spec parsers, `Diagram`, `Chart` and
`MapView`, plus `Timeline`, `Check`, `Compare`, `Stat`, `Spark` and the parser in `@goblin/kit/mdxcn`, each heavy
module its own entry so a message loads a library only when it first shows that kind. Agent apps use the same kit
components in their sandboxes; there is no second chart or map stack.

The mdxcn subset is adapted from shadcn-labs/mdxcn at `16d817ad5ec54d89142e4c1cf26027b60d6df853`, under MIT;
`packages/kit/vendor/mdxcn/` preserves its license and provenance. It keeps read-only data forms and subtle
220 ms fade-up/stagger entrances, implemented in CSS and disabled by `prefers-reduced-motion`. Frames follow
their container width; comparison tables scroll internally, stat grids wrap and long labels stay visible.
Graph tokens map locally to goblin's semantic and chart tokens, so light/dark share one palette. No MDX compiler,
Comark parser, catalog, interaction, network dependency or migration is introduced.

**Diagrams are inert images.** beautiful-mermaid (1.5 MB, a fraction of Mermaid's 5.2 MB) lays out flowchart,
sequence, class, state and ER diagrams and xycharts. Its SVG becomes an `<img>` data URI, so nothing in it runs, links
or loads; its unconditional Google Fonts import is removed and it uses the system font. An image cannot read the
page's CSS, so the theme's tokens are resolved to concrete colours when it is drawn, and it redraws when the theme
changes. Mermaid's other diagram types (gantt, pie, mindmap, timeline, journey, gitgraph) stay code.

**Tokens, not palettes.** Charts and map lines use `--chart-1` … `--chart-5` (blue, teal, amber, magenta, red-orange,
at one lightness, each at least 3:1 on a card, light and dark), so blocks follow the theme without a second palette.

**One tile host.** Maps use OpenStreetMap's standard raster tiles (`tile.openstreetmap.org`) with its attribution,
under its tile usage policy, which allows light use like a personal agent's. A CSS filter quiets them to the theme
(inverted in the dark); markers and lines keep their colours. It is the only network a block uses. CARTO's basemaps,
the first choice, now answer every keyless request with an "API key required" tile. Vector maps are out: they need
WebGL and workers that agent app sandboxes will not allow.

Consequences:
- Replies on Telegram use plain text; drawn fences would show as code there.
- OpenStreetMap's tiles are donated and not for heavy use: before production, review traffic and move to a tile
  provider of goblin's own if it grows.
- A large diagram lays out on the page's thread; sources over 20,000 characters stay code.
