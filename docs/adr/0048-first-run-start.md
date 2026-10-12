# 0048: First-run Start

It builds on ADR 0043 (first-class servers), 0045 (Goblin Wallet) and 0047 (paid inference).

## Context

The owner's first session on goblin.surf hit a chain of dead ends:
- nothing asked how goblin should pay;
- the Goblin Wallet was not offered;
- the free Credits ran out in minutes;
- a new wallet refused to pay with no way to see its address and fund it.

goblin is not really usable without a funded wallet and Mercator, and an unfunded free account gets no Credits at all
(ADR 0047). So it cannot even be asked for help.

## Decision

**Start stands before the chats.** `/start/<step>` is a full-screen page with one task per screen, four of them
(amended 2026-10-12, after the owner's first runs found six confusing):
1. welcome: what goblin is (an agent that works through the MCP servers the owner connects and allows, and pays for its
   own model and services from the Goblin Wallet, within the owner's limits);
2. the Goblin Wallet: connected, set up and funded;
3. services: how goblin reaches the outside world, Mercator first;
4. what the owner wants goblin for.

The owner can skip a step or all of Start. Its state is the agent's: `app_onboarding` holds what the owner said
(finished, skipped, the welcome and services steps, the kickoff). Every other step is read live from the connections,
grants and the wallet's own status (`GET /api/onboarding`).

**The wallet owns its setup and its funds.** goblin never shows an address to fund or a balance step of its own. The
wallet's status lists what is left to set up there (`setup`, its own phrases, which Start shows as plain text), and
Start sends the owner to the wallet's setup page, `<wallet origin>/setup?return=<goblin>/start/wallet`, which walks
adding funds and turning on spending and comes back. goblin builds that link from the connection's configured endpoint,
never from what the server says. The wallet is ready once its status reads, lists no setup and has an address goblin
pays from; funded once ready and holding what the plan asks (`GOBLIN_FREE_WALLET_USD` on the free plan, anything on
another). Once ready, Start shows what it holds and how goblin pays for its model, with Change. A sign-in that includes
the wallet's setup takes longer, so a pending authorization and Start's connect note live an hour.

**Mercator is optional.** It is the services step's featured card, not a condition of finishing Start.

**An untouched Start is derived, then kept.** It is open until the wallet is ready and funded, so an account that is
already set up never sees it. The first time it is found complete, `done` is kept, so the gate's later reads ask no
server. Going through a step never sets the status: only finishing, skipping or reopening does.

**The gate decides before the app is drawn.** Pages that wait for Start (`staticData.startRequired`: the chats and
Activity) show goblin's splash, not the rail and sidebar, until `GET /api/onboarding/status` (read beside the plan as
soon as someone is signed in) answers; an open Start goes from the splash to its first open step. Settings, Connections
and the subscribe pages are never gated, and a state that cannot be read lets the owner in.

**A sign-in Start begins comes back to Start.**
- `POST /api/onboarding/connect` notes the step, and whether to allow the server's recommended tools, against the
  connection (`app_onboarding_connects`, an hour).
- The OAuth callback takes the note: it allows the tools (ticked by default, listed before the owner leaves) and
  redirects to `/start/<step>` instead of Connections.
- Nothing about it lives in the browser. Every connection registers with its authorization server as plain `goblin`.

**A goblin that cannot answer says why, without the model.** While the day's allowance is none, the chat's dock shows
what is left to set up, with Continue setup, and the owner's message waits in the composer. A skipped Start with
something left gets one quiet line back to it.

**The agent knows what is missing, in main only.** A trailing `<onboarding>` part of goblin's context block says that
goblin pays for itself from the Goblin Wallet (and where its setup page is), and lists only the gaps, Mercator marked
optional, read without calling any server. The kickoff is recorded before its message is sent; right after it the
block asks the agent to propose Topics and Personas with one `ask_user` and to create only the chosen ones.

## Consequences

- A sign-in that fails before goblin knows its connection (the authorization server's own error) still lands on
  Connections.
- An unfunded free account cannot ask goblin anything, by design. Start and the dock card are its way forward.
- Funding happens in the wallet. goblin's Start can only show what the wallet reports and link to its setup page.
- A Start row written by the six-step Start keeps working: step ids it no longer has are dropped when it is read.
- Every visit to a chat shows the splash until the Start state answers; once `done` is kept, that answer is local.

## Rejected

- **A free starter allowance without a wallet.** The owner wants the wallet first.
- **Funding inside goblin** (the six-step Start's address, QR code and Add funds App). Funding belongs to the wallet,
  whose consent already walks it; two places to fund confused the owner.
- **Guidance as model turns only.** They need Credits the account does not have.
- **The return trip in the browser's storage.** It needed a page-load effect to allow tools, and a forward from
  Connections that drew the wrong page first.
