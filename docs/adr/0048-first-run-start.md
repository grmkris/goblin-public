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

**Start stands before the chats.** `/start/<step>` is a full-screen page with one task per screen:
1. the Goblin Wallet;
2. its funds;
3. how goblin pays;
4. Mercator;
5. more services;
6. what the owner wants goblin for.

The owner can skip a step or all of Start. Its state is the agent's: `app_onboarding` holds what the owner said
(finished, skipped, the steps only they can mark, the kickoff). Every other step is read live from the connections,
grants and the wallet's own status (`GET /api/onboarding`).

**An untouched Start is derived.** It is open until the wallet is funded and Mercator is in, so an account that is
already set up never sees it. The chat routes send an owner to Start while it is open (`OwnerGate startRequired`, which
reads the cheap `GET /api/onboarding/status`). Settings, Connections and the subscribe pages are never gated.

**A sign-in Start begins comes back to Start.**
- `POST /api/onboarding/connect` notes the step, and whether to allow the server's recommended tools, against the
  connection (`app_onboarding_connects`, half an hour).
- The OAuth callback takes the note: it allows the tools (ticked by default, listed before the owner leaves) and
  redirects to `/start/<step>` instead of Connections.
- Nothing about it lives in the browser.

**A goblin that cannot answer says why, without the model.** While the day's allowance is none, the chat's dock shows
what is left to set up, with Continue setup, and the owner's message waits in the composer. A skipped Start with
something left gets one quiet line back to it.

**The agent knows what is missing, in main only.** A trailing `<onboarding>` part of goblin's context block lists only
the gaps, read without calling any server. Right after the kickoff it asks the agent to propose Topics and Personas
with one `ask_user` and to create only the chosen ones.

## Consequences

- A sign-in that fails before goblin knows its connection (the authorization server's own error) still lands on
  Connections.
- An unfunded free account cannot ask goblin anything, by design. Start and the dock card are its way forward.
- Funding is the wallet's own App, opened on its Add funds panel (`/connections/<id>/app?focus=add_funds`). Start shows
  the address it pays from (`WalletStatus.payFrom`) with a QR code.

## Rejected

- **A free starter allowance without a wallet.** The owner wants the wallet first.
- **Guidance as model turns only.** They need Credits the account does not have.
- **The return trip in the browser's storage.** It needed a page-load effect to allow tools, and a forward from
  Connections that drew the wrong page first.
