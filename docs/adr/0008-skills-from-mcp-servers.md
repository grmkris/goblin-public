# Skills come from MCP servers the owner turns them on for, and the agent drafts new ones for review

Accepted 2026-10-05 with the owner, in the MySkills plan (myplan "03 MySkills + Purrable — final plan").

**Skills are read over MCP, not installed.** The agent speaks the MCP Skills extension (`io.modelcontextprotocol/skills`,
SEP-2640): `skills/list` and `skills/get` for entries, `resources/read` for files. The official TypeScript SDK has no
Skills support yet, so `skills/protocol.ts` decodes the published shapes itself and the client sends them as extension
methods. Nobody manages a skills folder in Purrable. The Agents SDK's Pi `skills()` helper is not used: it loads
every skill on each wake, freezes the catalog and forgets which server served a skill.

**A skill is an instruction the owner chose, which is why it needs a switch.** Remote content is untrusted data and
never becomes instructions (ADR 0003). A skill is a procedure the agent follows, so the owner turns skills on per
server ("Use skills from this server", `app_skill_sources`). Without that switch no server's skills are listed or read.
With it, the agent follows the steps of a skill it activates, but a skill never grants a permission: tools it names
still need the owner's exact grant, and text in it that asks for anything else is ignored and reported. There is no
prompt per skill: the owner chose the library, and MySkills' own per-agent reach and import review decide what that
library serves.

**Integrity follows the spec's host rules.** Skills are listed under host handles (`<server>:<name>`), so two servers'
skills never replace each other. Activation reads `SKILL.md` lazily and checks its size, SHA-256 and frontmatter
against the entry; supporting files are read only from the retained manifest and checked the same way. Generated
(`dynamic`) skills are declined. A conversation keeps the entry it activated (`app_skill_activations`), so its file
reads stay on that version and an update applies on the next activation. Verified bytes are cached by digest in the
agent's SQLite (`app_skill_files`) and checked again on every read; nothing is written to a filesystem. A server that
cannot be reached keeps its last listing or shows as unavailable, never as an empty library.

**Main and threads get skills; subagents do not**, unless a later change lets a spawner name them.

**The agent drafts skills; the owner publishes them.** After a final answer that followed a correction or a request
to remember how something was done, a cheap model decides whether the exchange teaches a reusable procedure. Facts
about the owner stay in memory (ADR 0007). A procedure becomes a draft sent through the library's `skill_draft` tool,
under the owner's normal tool grant; MySkills' review decides, and nothing in Purrable publishes a skill. The learner
proposes at most five drafts a day, never the same content twice, nothing while a draft for that skill waits, and
never a rejected draft again (`app_skill_drafts`). Drafts carry no transcript, and email- and secret-shaped text is
scrubbed.

Consequences: scripts in a skill are readable but never run. Revoking a library stops new reads and activations, but
cannot recall instructions already in a conversation. A server that changes its bytes without a new entry fails
verification until the entry is refreshed.
