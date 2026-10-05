# Telegram through myagent

Accepted 2026-10-04 with the owner. Supersedes the Telegram section of `docs/next.md`.

Amended 2026-10-05 by [ADR 0011](0011-mcp-events.md): servers advertising `capabilities.events` use exact
`message.received` and `question.answered` grants with `inbox` and `send_message`. Both Events leases confirm before
the old cursor is fenced and an immediate authoritative pull runs. Legacy servers retain the doorbell described
below until the announced mygram batch. Inbound `tg:<update>` identifiers keep the existing sanitized
`telegram-tg-<update>` operation mapping; reply IDs, escaping, chunking and pending reply records stay the same.

**The agent talks on Telegram through myagent, with a bot of its own.** myagent is the owner's Telegram-to-MCP
bridge. It holds several bots, and the owner binds each authorized MCP client to one of them. Purrable connects to
myagent like any other MCP server. The owner then picks that connection under Connections, "Use for Telegram". That is
an explicit owner action, and it does three things:
- grants the four tools the channel uses (`inbox`, `send_message`, `subscribe`, `unsubscribe`);
- reads to the end of the inbox, so older messages stay history;
- subscribes a doorbell.

At most one connection carries Telegram.

**Messages come in on a doorbell, and the agent pulls them.**
- myagent POSTs `{ botId, cursor }` to `/hooks/myagent/<userId>/<token>` after each new inbox entry.
- The token is an HMAC of the user id under a key derived from the credential key. The Worker checks it before any
  agent wakes, and it never names an agent from the request alone.
- The agent checks myagent's signature with the secret it gave myagent (sealed in `app_channel`, at most five minutes
  of clock skew). It then schedules a pull and answers at once.
- The pull reads `inbox` from the stored cursor, puts each new message from the owner into main authored "Telegram"
  (`telegram-<message id>`, so a repeat is the same submission), and moves the cursor page by page.
- A doorbell carries no message text: Purrable reads the messages through the grant like any other tool call.
- The pull needs current resident authority, like every outbound call.

**Answers go back with `send_message`.**
- Two kinds of turn in main are tracked in `app_channel_replies`:
  - every turn that came from Telegram;
  - every answer to a subagent's report in main.
- A scheduled delivery waits for each one to end. It then sends the final text: when the turn stopped on `ask_user`,
  the questions it asked; when it failed, a short note.
- The text is escaped plain text, in pieces under Telegram's limit, each with its own operation id.
- An answer still running after a day is given up. The owner answers a question card by replying on Telegram, which is
  an ordinary next message.
- The agent can also write first, with `send_message` through `mcp_call`, when it helps the owner.

Consequences:
- Telegram arrives in main, so memory, threads and subagents treat it like the web app. Main shows the author.
- The agent's Telegram depends on myagent's dev or prod stage being up. A doorbell myagent cannot deliver is retried
  every minute for a day. A missed one is caught up by the next, because the pull reads from the cursor.
- myagent stays single-owner: only the owner's agent gets Telegram. Another user would need myagent to become
  multi-owner first.
