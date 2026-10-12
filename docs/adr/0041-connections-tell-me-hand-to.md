# ADR 0041: Connections, Tell me and Hand to

Accepted 2026-10-11 with the owner, in a design interview; the plan is
0012 (routines) and 0033 (Personas). Amended 2026-10-12 by ADR 0048: every connection registers as plain `goblin`.

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
