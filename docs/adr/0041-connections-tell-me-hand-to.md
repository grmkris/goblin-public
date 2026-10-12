# ADR 0041: Connections, Tell me and Hand to

Accepted 2026-10-11 with the owner, in a design interview; the plan is
0012 (routines) and 0033 (Personas). Amended 2026-10-12 by ADR 0048: every connection registers as plain `goblin`.
Amended 2026-10-12 again (with the owner): the Events picker, the server's suggestions from `_meta`, and send to a
Topic or a Persona. See the end.

The owner wants goblin to listen to the platforms it is connected to. A Sidequest event, "you were picked for a job",
should reach them as a notification. An event can also wake Goblin or a Persona to act on it. They also want to run
two accounts of one platform side by side: a Sidequest hirer and a Sidequest worker.

Four things blocked this. goblin allowed one account per MCP server. An event could only start a model run. A Persona
could only answer when the owner tagged it. Inside a Persona's turn, an ask-first call failed and its Allow card never
reached the owner.

## Decision

### Connections

**A server is an address; a connection is the owner's account on it.**
- The owner may connect one server several times. Each connection has:
  - a label the owner gives it, unique on the agent (e.g. "Sidequest · Hirer");
  - its own OAuth sign-in and client registration;
  - its own grants, ask-first settings, skills switch and Events subscriptions;
  - its own Events webhook URL.
- Everything that was keyed by a "server id" is keyed by the connection's id (`connectionId`). The model's tools
  take a `connectionId` too.
- The model sees a connection's label, which is the owner's own text, bounded. It never sees the claims on a server's
  card (ADR 0006).
- MCP has no standard way to say which account a sign-in reached, so goblin cannot show it. The registration's
  `client_name` is "goblin · <label>", so the provider's consent screen names the connection being signed in.

### Routines

**A routine says when, whether to tell the owner, and who to hand the work to.** A routine has:
- a trigger: once, a cron schedule, or an MCP Event of one connection;
- a Topic;
- **Tell me** (on or off, and optionally Telegram);
- **Hand to**:
  - nobody;
  - Goblin, with an instruction;
  - a Persona, pinned to the revision the owner confirmed, with an instruction.

A hand-over carries its allowed tools and budget. A routine that neither tells nor hands over does nothing and is
refused. Routines remain the one engine: confirmation, receipts, pause, budgets, run limits and Topic bounds (ADR 0040)
apply to all of them.

**Tell me means every post of the routine is a notification.**
- An event's **notice** comes first, then the answer if there is a hand-over.
- A schedule with no hand-over posts a reminder. A schedule with a hand-over notifies its answer.
- A manual run is never a notification: the owner is there.
- Without Tell me, answers still post in the Topic as unread, but not as notifications.

**What a notification is.**
- It is a message in the routine's Topic. The model sees it as framed, untrusted data: plain text, bounded, http(s)
  links only. It never becomes an instruction.
- It is listed in Activity's Notifications section and raises the Activity badge, like a mention. It can also go to
  Telegram.
- An event's text is the producer's own title, summary and link, by convention (MCP Events has no summary field).
  Otherwise it is "<event> from <label>".
- Each routine gets at most 20 notices an hour in its chat and on Telegram. Past that, a notice is still kept in
  Activity, and one digest line in the chat says how many more are there (amended 2026-10-12: in the showcase run
  the job-delivered notice was folded away and never shown).
- A replayed event that occurred before the routine was confirmed, or more than a day ago, is acknowledged and
  dropped.

### Personas

**A Persona can be handed an event or a schedule.**
- It runs in the routine's own run conversation, not as a fork of the Topic, so it is bounded like any run: deadline,
  Stop, token caps and run usage.
- Its scope is the routine's allowed tools ∩ (its Topic's setup ∪ the Persona's setup at the pinned revision).
- Editing the Persona asks the owner to confirm the routine again.
- Its answer is written into the Topic attributed to the Persona.

**A Persona's held calls reach the owner.**
- When a Persona, routine-woken or owner-tagged, calls an ask-first tool or one not yet allowed, the owner sees the
  approval or Allow card under the Persona's answer and in Activity.
- Their decision resumes the same Persona, which answers again.

### Events

goblin detects Events from either the top-level `capabilities.events` its first producers used, or the
`io.modelcontextprotocol/events` extension of the draft SEP-3415.

## Rejected

- **Several accounts as separate goblin users.** Two logins, two Telegram channels and no shared Topic are a high
  cost to pay for one person running two roles.
- **One account with both roles.** Sidequest binds one agent per sign-in. A hirer and a worker are two identities,
  each with its own wallet.
- **A separate event-subscription engine beside routines.** It would duplicate confirmation, budgets, pause and
  receipts.
- **A Persona hand-over as a fork of the Topic.** Every event would replay the Topic's whole history, and the run
  would be charged twice: once by the chat's budget and once by the routine's.
- **Identity from the provider.** There is no standard call, and a server-specific one is untrusted text.

## Consequences

- goblin is greenfield until launch:
  - migrations are edited in place;
  - dev is reset with `destroy:dev`;
  - prod needs the owner's decision when this is released there.
- The Events store keeps every live subscription in its maintenance sweep and prunes retired ones. The cap is per
  agent, across connections.
- Two connections to one server subscribe to the same event with different webhook URLs. A producer that keys
  subscriptions without the principal still delivers each subscription separately.

## Amended 2026-10-12: the Events picker

When Kris connected mysi and set up its events, the section showed raw ids (`message.received`), one Set up per event
that each opened the whole routine editor, filters as raw JSON, a review that read "Only events matching `{}`", no
preview, and on a free account a 402 (now Tell me on free, hand-over on Pro: ADR 0012, amended). His direction: if the
server suggests defaults, use them; inside goblin an event goes to a Topic or a Persona, and that is it; filters, an
instruction and Tell me go under Advanced.

**Suggestions from the server.** An event descriptor may carry `title` and `_meta["lol.mysi/suggest"]`:
`{ title, summary, group, recommended, tellMe, rate: 'often' | 'daily' | 'rare' }` (myapps adds them; filter arguments
gain titles, descriptions and defaults; payloads carry `title`, `summary` and `url`, which notices already read).
goblin decodes them leniently, field by field, so a malformed `_meta` never fails the list, and passes them to the
owner as `EventStream` fields. They are claims: they pre-select and they name things, and they never grant or confirm
anything. Through mysi an event is `<service>.<event>` both as subscribed and as delivered, so the name checks at
ingress and dispatch stay as they are.

**The picker.** A connection's Events section lists its events by group with their titles (else the name in words),
summaries and a quiet rate. While the offer is open, the recommended ones are picked: one the server says to tell the
owner about goes to Tell me in Personal; one it recommends without `tellMe` is work for the agent, handed to goblin in
Personal on Pro and left unpicked on the free plan. With no suggestion nothing is picked. Each picked event has one
compact select:

- **Tell me in #Topic**: a notice there (free);
- **goblin acts on it in #Topic**: a hand-over to Goblin in that Topic (Pro);
- **@Persona acts on it**: a hand-over to that Persona, answering in Personal (Pro).

Advanced (folded) holds the filters from the event's schema (a nullable or optional string is a plain optional field;
JSON only for what a flat form cannot hold), the handler's instruction (goblin writes one when it is left empty) and
Tell me and Telegram. A preview line shows the notice the owner will see, from the suggestion; a quiet line states the
limits above (one run a minute, 20 notices an hour then a digest, replays from before setup dropped). One action sets
up every picked event: each one's routine is proposed and then confirmed at that revision, one after another, so each
confirmation still grants exactly its own selector. The owner's click is the review: the picker shows each event, its
filters and where it goes. A hand-over from the picker carries no tools until the owner adds them in the editor.

What is set up lists as "`<title>` → #Topic" (or "→ goblin, in #Topic", "→ @Persona"), with Pause or Resume and Edit;
Edit opens the full editor, which, like the routine's card, names events by title and says which ones it takes in
words. An event the Telegram channel already consumes (MyGram's two) says "Already arrives through Telegram" instead of
being offered twice; goblin reads that from the channel's subscriptions (`EventHealth.telegram`), not the channel.

Rejected: a batch endpoint that confirms several events under one confirmation (each selector keeps its own); a
separate "send to" model beside routines (routines stay the one engine).
