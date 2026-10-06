# ADR 0023: Chat blocks, one kit

Accepted 2026-10-06 with the owner, as part of the agent apps plan. goblin's chat did not draw Mermaid; agent apps
will need diagrams, charts and maps too, in goblin's design language.

**Three blocks.** The agent's replies draw ```mermaid, ```chart and ```map fenced blocks. A chart is JSON: a type
(line, bar, area, pie), a category key `x`, up to five series and up to 500 rows. A map is JSON: markers and lines in
latitude/longitude, or a center and zoom; it fits whatever it holds. Everything else stays a code block, and so does
a block whose source does not parse or fails to draw: model output is untrusted, so a block can never break a
message. While a reply streams, the block whose fence is still open stays code until it is whole.

**One kit.** `packages/kit` (`@goblin/kit`) is the one implementation: the spec parsers, `Diagram`, `Chart` and
`MapView`, each heavy module its own entry so a message loads a library only when it first shows that kind. Agent
apps will use the same components in their sandboxes; there is no second chart or map stack.

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
- The persona describes the three shapes in a few lines; replies on Telegram show them as code.
- OpenStreetMap's tiles are donated and not for heavy use: before production, review traffic and move to a tile
  provider of goblin's own if it grows.
- A large diagram lays out on the page's thread; sources over 20,000 characters stay code.
