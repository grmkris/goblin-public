# Home Surface and Agent-Controlled Widgets

Status: **Proposed planning artifact**. This document describes a possible next feature; the layout API, persistence model, widget catalog and browser acceptance below are not implemented unless marked as current code.

## 1. Goal

Make Main feel like a home surface for the owner:

- scrolling up reveals older exchanges and history;
- the newest exchange sits above the lower edge instead of being pressed against the composer;
- a bento grid appears between the newest exchange and the input;
- the agent can add, remove, arrange and update widgets in that grid;
- widgets can be host-built components, agent-built app views, or MCP Apps from connected servers.

The first useful interaction is: “Build me a reading list and put it on Home.” The agent builds the app, places its view in the grid, and the owner can use it without losing the conversation.

## 2. Terminology and current decisions

These are decisions already present in the codebase:

- **Agent app:** code written through `app_build`, with durable JSON state, actions, schedules and an optional `view.tsx`. Releases are validated and run in isolated Dynamic Workers. Main and ordinary threads get the app tools; subagents and routine runs keep their own extension lists. See [ADR 0021](./adr/0021-agent-apps.md) and [app UI documentation](../packages/app/docs/ui.md).
- **MCP App:** a `ui://` resource supplied by an MCP server after a tool call. The browser renders it in the sandbox, and all calls still require the owner’s current grant. It is not agent-authored code.
- **Pi ownership:** Pi owns transcripts, tasks and recovery. Drizzle application tables own application metadata. A Home layout must follow that boundary.
- **Untrusted data:** MCP results, App context and remote content remain data, never authority or instructions.

The following are proposed decisions for this feature:

- Home is a view of **Main**, not a replacement for the conversation workspace.
- The Home grid is host-managed so it can compose several widget types safely.
- Home layout is application metadata, separate from Pi transcripts and separate from any one app’s state.
- The first version uses one canonical live iframe per App. Moving an App between transcript, Home and its page moves its stage rather than duplicating it.

## 3. Current implementation seams

The existing code already supplies most of the runtime pieces:

- `Conversation` uses the patched MessageScroller, loads earlier history, starts at the end, and anchors owner turns so the latest turn is not flush with the bottom ([conversation.tsx](../apps/web/src/components/conversation.tsx#L24-L95)).
- `ConversationPane` composes the transcript and the fixed `ConversationDock` ([conversation-pane.tsx](../apps/web/src/components/conversation-pane.tsx#L250-L320)).
- `ConversationDock` owns the composer, interaction cards, App context chips, presence and usage state ([conversation-dock.tsx](../apps/web/src/components/conversation-dock.tsx#L100-L183)).
- `AppHost` keeps one loaded instance per App, with a soft cap and lazy residency ([host.tsx](../apps/web/src/components/apps/host.tsx#L30-L72)).
- `Stage` currently follows either `app-inline:<id>` or `app-page:<id>` ([stage.tsx](../apps/web/src/components/apps/stage.tsx#L172-L240)); Home needs a third placement.
- The workspace feed already streams conversations, activity and Apps ([workspace/feed.ts](../apps/runtime/src/workspace/feed.ts#L35-L58), [contracts](../packages/contracts/src/index.ts#L442-L458)).
- `AppView` identifies an App and its source, but has no Home placement or layout metadata ([contracts](../packages/contracts/src/index.ts#L287-L299)).

The root workspace route currently restores the device’s pane arrangement; it is not a dedicated dashboard ([`_workspace.tsx`](../apps/web/src/routes/_workspace.tsx#L1-L17)).

## 4. Target interaction

On Main, the vertical order should be:

```text
older messages
current exchange
Home bento grid
composer dock
```

**Proposed:** put the grid in the MessageScroller content after the newest transcript parts, with the composer as fixed chrome. Validate this in the layout spike: the existing scroller follows the end, which would become the grid's end, and its reserved space and turn map currently measure message content. Opening Home and “Back to now” must target the current exchange, not jump below all the widgets. The latest answer may be long; it should remain fully readable without forcibly shrinking it to fit the grid.

When the owner is reading older history:

- incoming streamed content must not yank the viewport;
- widget updates must not yank the viewport;
- a visible “Back to now” control returns to the newest exchange and Home grid;
- loading earlier pages must preserve the current visual anchor.

If “previous conversations” means threads and other conversations rather than earlier messages, Home should provide a recent-conversations widget backed by the workspace feed. The transcript itself remains conversation-scoped.

## 5. Widget model

Proposed application-level schema:

```ts
type HomeWidget =
  | { kind: 'builtin'; id: string; type: string; config: unknown }
  | { kind: 'app'; id: string; appId: string }

type HomePlacement = {
  widgetId: string
  column: number
  row: number
  width: 'small' | 'medium' | 'wide'
  height: 'short' | 'tall'
  hidden?: boolean
}

type HomeLayout = {
  revision: number
  widgets: HomeWidget[]
  placements: HomePlacement[]
}
```

The exact schema is **Proposed**. Resolve an App's source from the existing registry, not from a client-supplied source claim. Built-in `config` needs a separate validated schema per widget type. Bound counts and coordinates, validate placement references, prevent duplicate placements for one App, and keep a stable revision. Layout changes should use stable operation IDs and reject stale revisions rather than silently overwriting a concurrent owner or agent edit.

Initial built-in widget types should stay small:

- list or task summary;
- metric or status summary;
- chart using the existing kit;
- recent conversations;
- calendar or timeline only after a real data source is selected.

An agent app’s `view.tsx` remains the path for custom UI. Its view can use `@goblin/ui` and the existing chart, map and diagram kit, but it cannot directly fetch arbitrary network data or embed another App. Its action `prepare` may use explicitly approved powers.

For an MCP-backed widget, use an authorized action to fetch and validate data, keep the result in app state, and push state revisions to the view. Existing app schedules can refresh it without a model turn, at the currently supported intervals starting at 15 minutes. Showing the tile must not run a model or imply a live subscription. Built-in widgets need an explicit data adapter and refresh policy; MCP tool schemas are not interchangeable widget schemas. Show freshness, loading and failure states, retaining the last good data when appropriate. See [powers](../packages/app/docs/powers.md) and [schedules](../packages/app/docs/schedules.md).

## 6. Agent and owner control

Add a dedicated Home service and agent extension rather than making the agent write browser layout state directly.

Proposed agent tools:

- `home_read`: return the current layout and available widget references;
- `home_add`: add a built-in widget or an existing App;
- `home_move`: change a placement;
- `home_resize`: change a bounded size;
- `home_remove`: remove a placement while leaving the underlying app alive;
- `home_update`: update a widget’s validated configuration.

Owner drag, resize, hide and remove controls should call the same service. The agent can propose or apply presentation changes according to the normal owner-authority policy; placing a widget must never grant a server, tool or power.

The workspace feed should carry Home layout changes so another open tab updates without polling. A first implementation may keep the layout in the existing agent object’s application SQLite; a later multi-member design would need an explicit authority decision.

## 7. Rendering and App lifecycle

Add a `HomeSurface` component to the Main conversation. It should:

1. read the Home layout from the workspace feed or a scoped Home endpoint;
2. render built-in widgets directly;
3. register `home:<appId>` slots for App stages;
4. let `AppHost` follow `inline`, `home` or `page` placement;
5. preserve the existing origin binding, grant checks, context sharing and teardown behavior;
6. keep the current live-App residency cap and unload off-screen stages to stubs.

Current context chips route to an App's home conversation ([offers.tsx](../apps/web/src/components/apps/offers.tsx#L85-L100)). A tile on Main may originate in a thread, so explicitly decide whether its “share” targets Main or that thread; preserve the runtime's registry-derived origin and untrusted label. Define page-over-Home-over-transcript placement precedence and show a return control at displaced locations. Distinguish “Remove from Home” from the existing “Close app” control. Closed or deleted Apps should leave a clear recoverable tile or remove their placement, rather than silently loading again.

The six-instance residency cap is currently soft: visible Apps are not evicted. Start with a small number of App tiles and measure a full visible grid instead of assuming six is a hard memory limit. See [ADR 0020](./adr/0020-durable-apps-one-iframe-per-instance.md).

The first version should display an App in one canonical live location at a time. If simultaneous transcript and Home instances become necessary, introduce explicit instance keys and test bridge identity, origin binding and teardown for each instance before enabling it.

## 8. Phased implementation

### Phase 0: layout spike

- Add a local-only `HomeSurface` with a static, typed fixture layout.
- Place it after Main’s newest transcript content and before the composer dock.
- Add responsive grid behavior and the “Back to now” interaction.
- Prove that streaming, history prepend, widget resize and App movement preserve scroll position.

### Phase 1: one real agent app

- Use a reading-list or task-tracker agent app with a real `view.tsx`.
- Add Home placement and move-to-page controls.
- Use a temporary local placement fixture while proving movement and reload; server persistence lands in Phase 2.
- Keep the app’s existing action/state path unchanged.

### Phase 2: layout ownership

- Add the Home service, contracts, application storage and workspace-feed changes.
- Persist the placement per owner and restore it after reload, using additive `app_*` migrations.
- Add the `home_*` agent tools with operation IDs and stale-revision handling.
- Add owner drag, resize, hide and remove controls.

### Phase 3: widget catalog

- Add built-in list, metric, chart and recent-conversations widgets.
- Add MCP App placement only after verifying its originating-server and grant behavior from Home.
- Document which data source and owner grant each widget requires.

### Phase 4: acceptance and documentation

- Add browser acceptance for desktop, narrow screens, reload, two tabs, App movement and scroll anchoring.
- Add local workerd integration for layout persistence and feed reconstruction.
- Decide whether this requires a new ADR and update architecture and development docs only after behavior lands.
- Deployed dev acceptance and any production release are separate operator steps after local acceptance.

## 9. Acceptance criteria

The first complete vertical slice (Phases 0–2) is complete when all of these pass locally. Phase 0 can use fixture content; the full slice requires a real app and agent layout tools:

- “Build me a reading list and put it on Home” creates an agent app and a visible Home tile.
- Adding and completing an item works through the app view and survives reload.
- Home remains below the newest exchange and above the composer.
- Scrolling upward shows earlier messages without the composer moving.
- Streaming a reply while reading earlier history does not change the reader’s anchor.
- “Back to now” returns to the newest exchange and Home grid.
- Moving or resizing the tile does not reload the iframe or lose its state.
- Opening the app as a page and returning Home preserves its state and bridge behavior.
- A second tab receives the layout change through the workspace feed.
- Narrow screens stack the grid without horizontal overflow.
- Closing a tile removes its placement but does not delete the underlying app.
- No placement operation grants an MCP server, tool, power or credential.
- Replaying a layout operation does not duplicate a tile, and concurrent edits reject stale revisions.
- Unpinning, closing, deleting, upgrading and rolling back an App leave Home in a consistent state.
- When MCP tiles land, revoking their originating grant denies subsequent calls, and the bridge cannot reach another server.

Evidence must distinguish unit tests, local workerd integration, browser acceptance and deployed dev behavior. Unrun live or production claims remain unknown.

## 10. Risks, ADRs and open questions

### Risks

- A large number of live iframes could exceed the current residency assumptions.
- A dynamic grid can cause MessageScroller remeasurement and accidental viewport jumps.
- A server-provided MCP App may look like an ordinary widget while still requiring an originating-server grant.
- Agent and owner edits can race unless layout revisions and operation IDs are enforced.
- A dashboard app alone cannot compose independent MCP Apps or other agent app frames.

### ADRs to consider

- **Home Surface and layout ownership:** whether Home is Main-only, workspace-wide or a separate pane.
- **Widget authority:** which layout operations the agent may perform without owner confirmation.
- **App instances:** one canonical App stage versus multiple independently keyed instances.
- **Shared Home for members:** whether the layout belongs to one owner, one agent or a future workspace member group.

### Open questions for brainstorming

1. Should Home appear only under Main, or also under every conversation pane?
2. Should widgets scroll away with the transcript, or should some remain pinned above the composer?
3. Should the agent be allowed to remove or hide owner-placed widgets?
4. Should an owner’s drag be a device-local preference or shared server state?
5. Which first data source is most valuable: tasks, calendar, inbox, usage, or recent conversations?
6. Should an MCP App be pinnable only after the owner explicitly keeps it?
7. Should a tile click open the App page, focus its conversation, or expand in place?
8. Do we want a compact “Home” route/pane distinct from Main, or should `/` continue to restore the Main workspace?
