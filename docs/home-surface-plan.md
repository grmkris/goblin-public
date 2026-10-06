# Home Surface and Agent-Controlled Widgets

Status: **Implemented for dev (2026-10-06)**. Reviewed against the code on 2026-10-06; the review's changes are
folded into the sections below, its answers to the open questions are in section 10, the visual and motion direction is
section 11 and the definition of "delivered" is section 12. Slices 1–5 describe the implementation; the items under Later remain deferred.
The delivery target is `https://dev.goblin.surf`; production stays a separate owner step. Round 2 adds agent-made
figure snapshots, owner-pinned MCP Apps and a MyInbox scheduled-app pattern. MyGram's local/dev suggestion is unchanged
while its bot/account setup remains an owner decision.

## 1. Goal

Make Main feel like a home surface for the owner:

- scrolling up reveals older exchanges and history;
- the newest exchange sits above the lower edge instead of being pressed against the composer;
- a bento grid appears between the newest exchange and the input;
- the agent can add, remove, arrange and update widgets in that grid;
- widgets are host-rendered notes and recent conversations, agent-built app views, or MCP Apps pinned by the owner.

Home is a **glance surface**: one look answers "what needs me now?", one action can happen in place, and deep work
opens the App's page. Tiles are widgets in the iOS sense, not miniature copies of full apps.

The first useful interaction is: “Build me a reading list and put it on Home.” The agent builds the app, places its view in the grid, and the owner can use it without losing the conversation.

## 2. Terminology and current decisions

These are decisions already present in the codebase:

- **Agent app:** code written through `app_build`, with durable JSON state, actions, schedules and an optional `view.tsx`. Releases are validated and run in isolated Dynamic Workers. Main and ordinary threads get the app tools; subagents and routine runs keep their own extension lists. See [ADR 0021](./adr/0021-agent-apps.md) and [app UI documentation](../packages/app/docs/ui.md).
- **MCP App:** a `ui://` resource supplied by an MCP server after a tool call. The browser renders it in the sandbox, and all calls still require the owner’s current grant. It is not agent-authored code.
- **Pi ownership:** Pi owns transcripts, tasks and recovery. Drizzle application tables own application metadata. A Home layout must follow that boundary.
- **Untrusted data:** MCP results, App context and remote content remain data, never authority or instructions.

The following are decisions for this feature:

- Home is a view of **Main**, not a replacement for the conversation workspace. Threads, subagents and other panes do
  not get one.
- The Home grid is host-managed so it can compose several widget types safely.
- Home layout is application metadata, separate from Pi transcripts and separate from any one app’s state.
- The first version uses one canonical live iframe per App. Moving an App between transcript, Home and its page moves its stage rather than duplicating it.
- **A tile has fixed geometry.** Its height comes from its size class, never from its content or an App's `resize`
  request. Fixed geometry is what keeps the scroller from jumping (section 4) and the grid from reflowing while frames
  load.
- **The layout is an ordered list, not coordinates.** Order and size are shared server state; the number of columns
  is a property of the screen. A phone and a desktop show the same order without a per-device layout to reconcile.
- **An App knows it is on Home.** The host context tells a view its surface and tile size, so the view can render a
  glance variant instead of its inline UI squeezed into a tile.

## 3. Current implementation seams

The existing code already supplies most of the runtime pieces:

- `Conversation` uses the patched MessageScroller, loads earlier history, starts at the end, and anchors owner turns so the latest turn is not flush with the bottom ([conversation.tsx](../apps/web/src/components/conversation.tsx#L24-L95)).
- `ConversationPane` composes the transcript and the fixed `ConversationDock` ([conversation-pane.tsx](../apps/web/src/components/conversation-pane.tsx#L250-L320)). `useDockInsets` already reserves the dock's height in the pane, so Home's last row can clear it.
- `ConversationDock` owns the composer, interaction cards, App context chips, presence and usage state ([conversation-dock.tsx](../apps/web/src/components/conversation-dock.tsx#L100-L183)).
- `TurnMap` on the transcript's right edge lists the owner's turns and jumps between them ([turn-map.tsx](../apps/web/src/components/turn-map.tsx)); Home becomes its last mark.
- `AppHost` keeps one loaded instance per App, with a soft cap and lazy residency ([host.tsx](../apps/web/src/components/apps/host.tsx#L30-L72)).
- `Stage` follows `app-page:<id>`, then `app-home:<id>`, then `app-inline:<id>` and springs between them with the house `PLACE` spring (damping 1, response 0.4, [spring.ts](../apps/web/src/lib/spring.ts)) without reloading ([stage.tsx](../apps/web/src/components/apps/stage.tsx)).
- `AppPlacement` and `hostContext` ([host-context.ts](../apps/web/src/lib/host-context.ts)) give a frame its display mode, surface, tile size and fixed room; Home also supplies the tile's card colour.
- The workspace feed already streams conversations, activity and Apps ([workspace/feed.ts](../apps/runtime/src/workspace/feed.ts#L35-L58), [contracts](../packages/contracts/src/index.ts#L442-L458)).
- `AppView` identifies an App and its source; `HomeLayout` holds its separate placement metadata ([contracts](../packages/contracts/src/index.ts)).
- App erase and rehome live in [agent-apps/erase.ts](../apps/runtime/src/agent-apps/erase.ts) and [manage.ts](../apps/runtime/src/agent-apps/manage.ts); deleting an App must drop its tile in the same operation.

The root workspace route currently restores the device’s pane arrangement; it is not a dedicated dashboard ([`_workspace.tsx`](../apps/web/src/routes/_workspace.tsx#L1-L17)).

## 4. Target interaction

On Main, the vertical order should be:

```text
older messages
current exchange
Home header (“Home · Tuesday, 6 October”  ·  Ask for a tile  ·  Edit)
Home bento grid
composer dock
```

Put the grid in the MessageScroller content after the newest transcript parts, with the composer as fixed chrome. It
is not a scroll anchor and not a message.

**“Now” is the existing turn anchor, not the scroller's end.** The scroller already puts a new owner turn at the top of
the view; “now” is that same position for the latest owner turn, with the reply and then Home below it. A short
latest exchange leaves Home visible without scrolling; a long one keeps the answer fully readable and Home one scroll
away. The scroller's end (the bottom of Home) is reached only by an explicit Home jump.
Home landing and its mark put the last grid row within 24 px above the dock, with reserved turn space between the newest exchange and Home, and no jump arrow at the end.

- **Landing.** Opening Main lands on “now” while the latest owner turn is from today (local time); otherwise it lands
  on Home. A new day starts on Home; an ongoing conversation resumes where it was.
- **Sending.** A new owner turn takes the anchor as today; the streaming reply pushes Home down and out of view. No
  special case is needed because Home is always below.
- **Reading history.** Home sits below everything the reader can see, and tiles have fixed geometry, so widget updates
  cannot move the anchor. Incoming content must not yank the viewport, and loading earlier pages must preserve the
  current visual anchor (current behaviour, kept under test).
- **Getting back.** The existing jump control returns to “now”. `TurnMap` gets a final Home mark that jumps to Home.

Validate this in the first browser spike of slice 2 (section 8): the scroller's reserved space and the turn map
currently measure message content only.

If “previous conversations” means threads and other conversations rather than earlier messages, Home provides a
recent-conversations tile backed by the workspace feed. The transcript itself remains conversation-scoped.

**Empty Home.** With no tiles, the copy says “Your agent can build tiles: trackers, charts, your inbox. Ask it.”
The prompts are “Track my reading on Home”, “Chart my spending this month on Home” and “Put my inbox on Home”.
Choosing one fills the composer; it never sends. The quiet Ask for a tile header button and edit-mode placeholder
fill “Add a tile to Home that ” and focus the composer.

## 5. Widget model

Schema, defined once in `@goblin/contracts` with Effect Schema and validated on every write:

```ts
/** Spans on the grid: small 1×1, medium 2×1, large 2×2, wide 4×1 (section 11 maps them to narrow screens). */
type TileSize = 'small' | 'medium' | 'large' | 'wide'

type TileBase = { id: string; size: TileSize; placedBy: 'owner' | 'agent' }

type HomeTile =
  | (TileBase & { kind: 'app'; appId: string })
  | (TileBase & { kind: 'conversations' })
  | (TileBase & { kind: 'note'; title: string; markdown: string })

type HomeLayout = {
  revision: number
  /** The order is the layout. */
  tiles: readonly HomeTile[]
}
```

Rules:

- Bounds: at most 24 tiles, at most 8 App tiles, a note's title ≤ 60 characters and markdown ≤ 4 KB.
- One tile per App. An App reference is checked against the registry; its source is resolved from the registry, never
  from a client-supplied claim. Deleting an App removes its tile in the same service call; closing it does not.
- Every write carries an `operationId` and an `expectedRevision`. A replayed operation returns the stored result
  without a second effect; a stale revision is rejected with the current layout so the caller can retry.
- Storage: one application row (`app_home`) per agent object holding the validated layout and its revision, written in
  one short transaction. Additive Drizzle migration only; dev holds real data.

Built-in tiles for the first delivery are the two that need no data adapter and no grant:

- **Recent conversations:** from the workspace feed; tapping a row opens that conversation's pane.
- **Note:** a title and markdown the agent (or owner) writes, rendered like a transcript message: markdown as data, no
  raw HTML, links through the existing link handling. It gives the agent a cheap way to put something on Home without
  building an app (“today: dentist 15:00, call Ana”). It renders the same stat, spark, timeline, compare, check and
  chart figures as chat. Home figures draw flat on the tile card and fit its fixed body, with clip/fade as a fallback;
  a snapshot names when the data was true.

There are no built-in metric or chart tiles. Snapshot figures live in notes; lists and live data use agent apps with
`@goblin/ui` and the kit. MyInbox is the chosen inbox source: an agent app declares the connected `message_list` tool,
validates and keeps the newest five messages, and refreshes every 15 minutes with freshness and last-good error
handling. There is no platform inbox adapter. See the `app_docs` `examples` topic.

**Agent app views on Home.** The host context gains a surface hint (`surface: 'home'`, the tile size and its fixed
width and height), exposed by the app SDK, so a view can render a glance variant: a headline, at most a handful of rows
and one primary action. Update the app UI documentation and the `app_build` guidance so new views handle it. A view
that ignores the hint still works: Home clips it to the tile with a bottom fade and keeps the tile's Open affordance.
An App's own `resize` requests are honoured inline and ignored on Home.

An agent app’s `view.tsx` remains the path for custom UI. It cannot directly fetch arbitrary network data or embed
another App. Its action `prepare` may use explicitly approved powers.

For an MCP-backed widget, use an authorized action to fetch and validate data, keep the result in app state, and push state revisions to the view. Existing app schedules can refresh it without a model turn, at the currently supported intervals starting at 15 minutes. Showing the tile must not run a model or imply a live subscription. MCP tool schemas are not interchangeable widget schemas. Show freshness, loading and failure states, retaining the last good data when appropriate. See [powers](../packages/app/docs/powers.md) and [schedules](../packages/app/docs/schedules.md).

## 6. Agent and owner control

Add a dedicated Home service and agent extension rather than making the agent write browser layout state directly.
Main and ordinary threads get the tools; subagents and routine runs do not.

Two tools instead of six:

- `home_read`: the current layout, its revision, and the Apps that could be placed (name, id, whether it has a view).
- `home_edit({ operationId, expectedRevision, ops })`: an ordered list of `add`, `move`, `resize`, `update` and
  `remove` operations applied atomically. “Set up my Home” is one call with one revision check and one receipt, and the
  agent's context carries two schemas instead of six.

Authority (presentation only; placing a tile never grants a server, tool, power or credential):

- The agent may add notes, recent conversations and agent apps with views, then move, resize, update or remove the
  tiles it placed. Applied immediately. MCP App adds require the owner and an open registry row; before the transaction,
  launch must be retrievable and the current tool must still declare its resource. Existing closed MCP tiles never
  block an unrelated edit.
- Removing or changing an owner-placed tile needs the owner: `home_edit` returns an ask instead of applying.
- Every agent edit leaves a receipt in the transcript (“Placed Reading list on Home”) with **Show** (scroll to the tile
  and ring it once) and **Undo** (apply the inverse operations under a new operation ID). Forgiveness instead of
  confirmation dialogs.

Owner controls call the same service:

- **Edit Home** in the Home header enters edit mode: drag to reorder, a size menu and Remove on each tile. Outside
  edit mode tiles are live and interactive.
- Every tile also has a menu that works by keyboard and screen reader: Open, Move earlier, Move later, Size, Remove
  from Home. Drag is never the only way to do something.

The workspace feed carries the layout in its snapshot and a `home` event with the full layout on every change, so
another open tab updates without polling. The layout lives in the agent object's application SQLite; a later
multi-member design would need an explicit authority decision.

## 7. Rendering and App lifecycle

Add a `HomeSurface` component to the Main conversation. It:

1. reads the Home layout from the workspace feed;
2. renders built-in tiles directly;
3. registers `app-home:<appId>` slots for App stages;
4. lets `AppHost` follow `app-inline`, `app-home` or `app-page` placement, with precedence **page > Home > inline**;
5. preserves the existing origin binding, grant checks, context sharing and teardown behavior;
6. keeps the current live-App residency cap and unloads off-screen stages to stubs.

- **Displaced places.** An App on Home shows a compact stub at its transcript place (“On Home” with a jump), and an App
  on its page shows the same at its tile. There is never a second frame.
- **Tile → page.** Open springs the same stage from the tile's rect to the page's rect with `PLACE`, and back along
  the same path. The App keeps its state and bridge because the iframe never moves in the DOM. This is the feature's
  signature interaction.
- **Lazy frames.** App tiles load only within about one viewport of the visible area, through the stage's existing
  `seen` reporting; until then, and when dormant under the cap, a stub of the tile's exact size shows the App's name
  and last update. Measure a full visible grid against the six-instance soft cap before raising the App-tile bound.
- **No layout shift.** Skeletons and stubs have the tile's final size. Loading Home must not shift layout.
- **Sharing.** A tile's context chip routes to the App's home conversation (current behaviour, registry-derived origin,
  untrusted label). When that is not Main, the chip names the destination.
- **Close vs remove.** The tile menu's “Remove from Home” drops the placement and leaves the App alive. The App's own
  “Close app” unloads it; its tile then shows “Closed · Show”. A deleted App's tile disappears with it. Nothing
  reloads silently.
- **MCP Show.** A closed MCP tile reopens through the keep-call POST, which re-verifies the tool; agent apps use the
  existing reopen PATCH. The label uses registry-derived origin and numbered titles, rendered as untrusted text.
- **Grant cards.** On Home the host card overlays the fixed frame, names the tool and offers Allow, Not now and Open.
  Frame and stage must fit the tile body after springs and resize reflow settle, including reduced motion.
- **Releases.** An upgrade or rollback reloads the frame in place (current behaviour); the tile keeps its position.

The six-instance residency cap is currently soft: visible Apps are not evicted. See [ADR 0020](./adr/0020-durable-apps-one-iframe-per-instance.md).
If simultaneous transcript and Home instances become necessary later, introduce explicit instance keys and test
bridge identity, origin binding and teardown for each instance before enabling it.

## 8. Delivery slices

Each slice ends green and deployed: `heavy bun run check`, commits by exact paths, deploy to dev, `smoke:dev`, and a
browser receipt where the slice has UI (section 12).

### Slice 1: layout service and feed (runtime, contracts)

- Home schema in contracts; `app_home` additive migration; Home service with operation IDs and revision checks.
- `home_read` / `home_edit` extension on Main and threads, with the owner-tile ask.
- App erase drops the tile; feed snapshot and `home` event.
- Local workerd integration tests: persistence, replay, stale revision, erase, feed reconstruction, bounds.

### Slice 2: Home on Main (web)

- Start with a local fixture spike that proves the scroll behaviour of section 4 before wiring the feed.
- `HomeSurface` with the header, responsive grid, empty-state prompts, conversations and note tiles.
- Landing rule, Home mark in `TurnMap`, transcript receipts with Show and Undo.
- Light and dark, narrow screens, reduced motion.

### Slice 3: App tiles

- `app-home:` slots, precedence, displaced-place stubs, fixed geometry, lazy frames.
- Surface hint in the host context and app SDK; app UI docs and `app_build` guidance.
- Tile ↔ page spring; close/remove/delete/upgrade/rollback states.
- The reading-list scenario end to end on dev.

### Slice 4: owner editing

- Edit mode, drag reorder (section 11), size menu, remove, keyboard tile menu.
- Two tabs stay in step through the feed.

### Slice 5: documentation and acceptance

- ADR 0025 (Home surface: layout ownership, agent authority, placement precedence).
- README, `docs/architecture.md`, `docs/development.md`, `packages/app/docs/ui.md` and the affected skills.
- The full acceptance run of section 9 on dev, with receipts.

### Round 2

- Agent-made snapshot figures in notes; Ask for a tile and refreshed starter prompts fill without sending.
- Owner-only open MCP App pinning, originating-resource verification, retained closed tiles and CSRF-protected writes.
- MyInbox suggestions and an agent-app pattern with a 15-minute refresh schedule; local fixture acceptance is distinct
  from owner sign-in and real-message acceptance on dev.

### Later

- Independent App instances.
- Server-side App-to-server route binding on `/api/apps/:id/mcp/...`; the current browser bridge is origin-bound.
- Calendar sources through agent apps when selected. Built-in metric/chart adapters are not planned.

## 9. Acceptance criteria

Run the applicable checks locally and on dev (`https://dev.goblin.surf`, owner session). When an MCP App server or
MyInbox is not connected, record the corresponding live checks as owner steps; use the no-auth local fixtures for
protocol and browser acceptance:

- “Build me a reading list and put it on Home” creates an agent app and a visible Home tile, with a receipt in the
  transcript.
- Adding and completing an item works through the tile and survives reload.
- Home remains below the newest exchange and above the composer; the last row clears the dock and the bottom safe area.
- Opening Main lands on “now” after a turn today, on Home otherwise.
- Scrolling upward shows earlier messages without the composer moving.
- Streaming a reply while reading earlier history does not change the reader’s anchor.
- The jump control returns to “now”; the Home mark returns to Home.
- Loading Home causes no layout shift (cumulative layout shift below 0.02 during load).
- Moving or resizing the tile does not reload the iframe or lose its state.
- Opening the app as a page and returning Home springs along the same path and preserves its state and bridge.
- A second tab receives the layout change through the workspace feed.
- Narrow screens stack the grid without horizontal overflow.
- Removing a tile drops its placement but does not delete the underlying app; deleting the app removes its tile.
- The agent cannot remove an owner-placed tile without asking; Undo restores the layout before an agent edit.
- No placement operation grants an MCP server, tool, power or credential.
- An agent cannot pin an MCP App; the owner pins an open App after launch and current tool-resource verification.
  Closing the App or its thread leaves the tile and does not block other edits; Show re-verifies.
- A revoked grant denies the next App tool call without changing layout or restoring a grant.
- The settled stage, frame and grant card stay inside the tile body in all four size/theme runs.
- A scheduled fixture inbox app validates and keeps the newest five messages, retains last-good data on failure and
  draws freshness/errors on Home. Real-inbox acceptance follows owner connection and power approval.
- Replaying a layout operation does not duplicate a tile, and concurrent edits reject stale revisions.
- Closing, upgrading and rolling back an App leave Home in a consistent state.
- Every tile action is reachable by keyboard; reduced motion replaces springs with short cross-fades.
- Screenshots at 1440×900 and 390×844, light and dark, are saved with a JSON receipt (section 12).

Evidence must distinguish unit tests, local workerd integration, browser acceptance and deployed dev behavior. Unrun
live or production claims remain unknown. A real-iPhone home-screen check is listed for the owner, not claimed.

## 10. Risks, ADRs and decisions

### Risks

- A large number of live iframes could exceed the current residency assumptions.
- A dynamic grid can cause MessageScroller remeasurement and accidental viewport jumps (mitigated by fixed geometry and
  Home's position below everything).
- A view written for its inline height can look broken in a small tile (mitigated by the surface hint, clip and Open).
- Agent and owner edits can race unless layout revisions and operation IDs are enforced.
- A dashboard app alone cannot compose independent MCP Apps or other agent app frames.
- `agent.ts` is near its size budget; the Home extension belongs in its own module, composed like the app tools.

### ADR

ADR 0025, written in slice 5: Home is Main-only; the layout is owner-scoped application metadata; the agent's authority
over tiles; one canonical stage with page > Home > inline precedence.

### Decisions (review, 2026-10-06)

1. **Home only under Main?** Yes. No other pane gets one.
2. **Pinned widgets above the composer?** No. Home scrolls with the transcript; the Home mark and landing rule reach it
   in one step, and the reading area stays whole.
3. **Agent removing owner widgets?** Only by asking. The agent freely manages tiles it placed; every agent edit can be
   undone.
4. **Device-local or shared drag?** Shared: order and size are server state. Edit mode is per device. There are no
   coordinates to keep per device.
5. **Data sources?** Recent conversations use the feed, snapshots use notes, and live data uses agent apps. MyInbox is
   the inbox source, refreshed on a 15-minute app schedule; there is no built-in adapter.
6. **Pin MCP Apps only after the owner keeps one?** Yes. Only the owner adds an open MCP App, after its call and current
   resource declaration are rechecked. Placement grants nothing.
7. **Tile click?** Interactive in place; Open (the tile title or its ↗) springs to the App page; the tile menu holds the
   rest.
8. **Separate Home route?** No. `/` keeps restoring the workspace; Home lives in Main.

## 11. Design direction

Keep the calm look: Geist, the oklch neutrals, hairlines and the warm off-white background. No new visual language, no
gradients, no accent colour of its own. The transcript is the paper; Home is the desk beneath it.

**Layout.** Home shares the transcript's reading column, so tiles align with the messages above them. Desktop: 4
columns, 0.75 rem gap, a fixed row height of about 9.5 rem. Below 640 px: 2 columns; `wide` becomes 2×1 and `large`
2×2. `grid-auto-flow: dense` packs the ordered list. Insets add `env(safe-area-inset-left/right)` in landscape.

**Header.** “Home” (13 px, weight 600, tracking 0.01 em) with the date in muted text and tabular figures, Ask for a tile beside Edit as a
ghost button on the right. Above it a hairline that fades out at both ends instead of a full-width rule.

**Tiles.** `--card` on the background with a `--hairline` border, `radius-2xl`, and a two-layer shadow in light mode
(a 1 px hairline plus a soft, low-opacity drop); in dark mode no drop shadow, a card one step lighter than the
background. Inside: a muted 12 px label top left, freshness (“Updated 4 min ago”) bottom right in muted text that turns
`attention` once data is twice as old as its refresh interval. Large numbers use weight 600, tabular figures and
−0.02 em tracking; body text stays 13–14 px. Errors use the existing `Receipt` inside the tile with Retry and keep the
last good data. Loading uses static muted blocks at final size, not a looping shimmer.

**Motion** (springs from `spring.ts`; no CSS keyframes for anything a pointer can grab):

- Tile ↔ page: the stage's `PLACE` spring (damping 1, response 0.4), along the same path both ways.
- A new tile materialises: opacity 0 → 1, scale 0.96 → 1 and blur 6 px → 0 together, damping 1, response 0.35.
  “Show” on a receipt scrolls to it and draws a 2 px ring once. Nothing loops.
- Press: tiles scale to 0.985 on pointer-down within 100 ms (not over a live App frame, whose pointer belongs to the
  App).
- Reorder in edit mode: a handle lifts on pointer-down with a mouse, after a 250 ms long press on touch; the lifted
  tile scales to 1.03 with a deeper shadow and tracks the pointer 1:1, keeping the grab offset (`setPointerCapture`).
  Other tiles reflow with `PLACE`. On release, project the landing point from the release velocity (deceleration
  0.998), pick the nearest slot, and settle with damping 0.8, response 0.3, carrying the release velocity. Edit mode
  never jiggles; handles and remove buttons fade in.
- Reduced motion: 150 ms cross-fades instead of springs and no blur. Reduced transparency: the dock's material turns
  solid.

**Materials.** Home scrolls under the dock's existing translucent material and scroll-edge fade. Tiles stay opaque:
never a translucent surface on another translucent surface.

**Installed web app (iPhone, iPad, Mac Dock).**

- The last row clears the dock height plus `env(safe-area-inset-bottom)` through the existing dock insets.
- Tile chrome gets `user-select: none`, `-webkit-touch-callout: none` and `touch-action: manipulation`; only a lifted
  tile gets `touch-action: none`, so vertical scrolling stays native and long press never opens the system callout.
- Hover-only affordances live in `@media (hover: hover)`; on touch the Open icon is always visible.
- Home adds no fixed or sticky full-width element near the top or bottom edge, so Safari 26's toolbar tinting keeps
  sampling the page as it does today.
- The owner checks a cold launch of the home-screen app on a real iPhone: landing position, long press, drag versus
  scroll.

## 12. Delivery

- **Live URL:** `https://dev.goblin.surf` (owner session). Production is not part of this delivery.
- **Delivered** means: every slice on `main`, deployed to dev, `smoke:dev` green, the section 9 run passed with
  receipts and screenshots in `.local/goblin-acceptance/home-*`, and docs and ADR 0025 updated. Owner-dependent MCP App,
  real-inbox and real-device checks are listed separately. Goblin's own Telegram setup belongs to the orchestrator and
  owner; the coding lane sends no status-channel Telegram update.
- **Routine per slice:** `heavy bun run check` (exit 75 means another gate holds the slot: retry; never pipe it);
  commit by exact paths; `bun run plan:dev`, then `bun run deploy:dev`; `bun run smoke:dev`. When the checkout holds
  another agent's uncommitted work, deploy from a clean worktree at `HEAD` with `.local/*.env` (mode 600) and
  `apps/web/.alchemy/state` copied in, and copy the Alchemy state back afterwards; never ship someone's WIP to dev.
- **Data:** dev holds real users' data. Migrations are additive; nothing rewrites or drops existing rows.
