# Composer commands, references and helper execution

Accepted 2026-10-08. Amends the execution limits in ADRs 0008, 0010, 0018 and 0021.

The composer keeps a native textarea. `/` opens skills plus `/help`, `/new-thread` and `/stop`; `@` opens connected
servers, skills and existing helpers. Selected entries become removable chips. Unselected tokens remain prose.
Enter or Tab selects, arrows browse, Escape dismisses, and IME composition never selects or submits.

The browser submits stable server IDs, skill URIs and helper conversation IDs. The runtime resolves current labels,
checks live scope and verifies selected skill bytes before model work. Multiple skills and skill-only messages are
allowed. A failed selection refuses the whole send and preserves the draft with its failing chip identified.
Connection entries are hints and grant nothing. Helper entries bring their latest report, bounded to 8,000 characters
and marked untrusted, into the current conversation; they never route the message to the helper.

Local commands act immediately. Help opens a popover, Stop aborts the current conversation, and New thread moves prose,
chips and portable in-flight attachments into a fresh draft pane. Full, draft and compact inline composers share the
same component and semantics.

Helpers receive MCP, skills, files, code, app execution, delegation and budget extensions. Owner questions, Home,
routine and app management, memory and skill learning remain parent-only. Spawn exclusions and the direct parent's
`subagent_config` narrow servers, tools, skill libraries, apps or delegation. Every ancestor remains a live ceiling;
app execution carries the calling conversation through nested apps and MCP dispatch. Retained helpers are configured
with the current execution extensions on reconstruction, through Pi's public configuration API.
