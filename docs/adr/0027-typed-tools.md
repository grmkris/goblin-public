# ADR 0027: Typed tools and one `app_call`

Accepted 2026-10-06 with the owner. Amends ADR 0021's per-app tools.

**Every tool has a typed input and a typed output.** A tool is defined with `typedTool` (`pi/typed-tool.ts`) from two
Effect Schemas. The model is offered the input as one self-contained JSON Schema (no `$ref`: providers differ on it);
the arguments are decoded through the same JSON form before the tool runs (an optional field may arrive as `null`),
and arguments that do not fit are an error result the model can fix. The output is encoded as JSON and kept as
`details.structuredContent`, beside the `details` fields the web reads (`kind` and the rest), the shape Pi's MCP tools
use; the model reads the output's JSON or a sentence the tool writes. A tool may return a ready result in place of its
output, without `structuredContent`: a refusal the web trusts by its details (`capability-off`), or content its output
does not carry (an image's bytes, which would be stored twice). Every typed tool's signature (name, description, input
and output schema) is listed for the callers that will want types: goblin's `/mcp` and codemode, which gets its own
design.

**A tool does one thing.** A tool that took an `action` and optional fields per action becomes one tool per action
(`routine` becomes `routine_propose`, `routine_list` and `routine_pause`), so each has an exact input and output and
the model cannot send a field the action ignores or miss one it needs. A routine is proposed as a typed
`RoutineDefinition`, not a JSON string.

**Apps are called through one tool.** `app_call(app, member, input)` replaces the tools each app added
(`app_<name>__<member>`): the tool list no longer changes when an app is built, renamed or deleted, which kept the
provider's prompt cache cold, and the app inventory with each member's input type is in the trailing
`<goblin-context>` block (`pi/context-tail.ts`). The input is an object, or the JSON string of one that models often
send for a free-form field; it is checked against the member's schema by the app dispatcher, and a result too large to
show is summarized as valid JSON rather than cut mid-text.

Consequences:
- Tools move to `typedTool` one at a time; the web renders old and new tool names, so stored transcripts still read.
- A call to an old tool name that Pi recovers after the switch fails once with an unknown-tool error.
- Tool annotations, descriptions and remote content stay untrusted data: types describe shape, never permission.
