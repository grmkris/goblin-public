# One live MCP App on a stage, told about its host, trusted for nothing

Accepted 2026-10-04 with the owner.

**One App, one iframe, never moved.** The chat view keeps at most one live App. Its iframe sits in a fixed stage that
stays put in the DOM, because re-parenting an iframe reloads it. MyPlan's panel holds a live editing session, and a
reload would drop it. The stage follows the slot its display mode names, frame by frame: the App's place under its
tool row, a resizable side panel, a phone bottom sheet, or picture-in-picture. It springs between slots (Apple's
damping and response, `lib/spring.ts`), so the App leaves the transcript and returns along the same path.
Picture-in-picture and the sheet are dragged by the host's chrome and thrown by projected momentum. We wrote the small
spring integrator ourselves rather than adding a motion library: it is about forty lines, unit-tested, and keeps
velocity when a target moves mid-flight.

**The App learns its host.** The bridge starts with a host context and re-sends it on change. It carries the theme,
our tokens as MCP Apps style variables, the device, locale and time zone, the display mode, the modes on offer and
the App's box. Fonts are a stack only, because the App's CSP will not load our files. Inline, the App picks its
height between 160px and 70% of the viewport. It may ask for another display mode and gets it where the screen offers
it.

**What an App asks for is drawn by the host, outside the App.** The App cannot draw over these:

- A link it asks to open (https, no credentials) becomes an offer with a real anchor, so only the owner's click opens
  it.
- Context it shares for the agent waits in a removable chip and goes with the owner's next message, once. The runtime
  appends it after the owner's words as its own block labelled `{ origin, trust: 'untrusted' }`. It is never merged
  into what the owner wrote, and the persona treats it as data.
- A call to a tool the owner has not granted waits on a card naming that exact tool. Allow grants it and runs the
  call again.

**Allow app grants exact tools.** One switch grants every tool that declares the App's `ui://` resource, the App-only
ones included, and the resource. It writes exact grants and adds no wildcard, and each tool stays listed.

**Credentials follow endpoints.** Stored credentials and grants are bound to the endpoint they were made for. A server
ID re-pointed to another host loses them at the next start, so tokens never travel between hosts.

**The sandbox is unchanged.** Apps run in two nested opaque `allow-scripts` frames. The outer proxy only relays
protocol messages to and from our origin. The App's CSP admits only the https and wss origins its resource declares,
with no frames, wasm or workers. MyPlan's panel needs nothing more: its own end-to-end test passes under a stricter
policy. Canvases open in MyPlan through a link offer.

Consequences: an App's own calls go only to its originating server, through the owner API. A second App replaces the
first. Threads (later) will hold their own App session; the stage itself does not change.
