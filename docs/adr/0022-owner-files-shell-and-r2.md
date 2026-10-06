# ADR 0022: The owner's files, in Shell's Workspace and R2

Accepted 2026-10-06 with the owner, as part of the agent apps plan (agent apps will write their own files the same
way, each in a namespace of its own).

**One store per agent.** The owner's files live in `@cloudflare/shell`'s `Workspace` over the agent object's SQLite
(`files/store.ts`), namespace `files`, so its tables are `cf_workspace_files*`. A file over 128 KiB spills to the
stage's R2 bucket (`FILES`, `stage.resourceName('files')`) under `agents/<userId>/files/<path>`. Shell owns those
tables as Pi owns `pi_*`: `storage/vendor.ts` treats the `cf_workspace_` prefix as vendor-owned, and no goblin
migration touches them. Shell, like Pi Durable, is experimental and pinned.

**Two areas.** `/uploads` holds what the owner uploaded, `/agent` what the agent wrote. A path is at most eight plain
segments (letters, digits, spaces and `_ . ( ) -`, none only dots; the `FILE_PATH` contract). The owner reads,
writes and deletes both; the agent reads both and writes or deletes only under `/agent`, so nothing it is told can
overwrite what the owner gave it. The agent's tools are `files_list`, `files_read` (text only, 48 KB a page; another
file is described, not dumped), `files_write` and `files_delete`, on main and threads.

**Limits before bytes.** 25 MiB a file, 512 MiB and 2,000 files in all (`FILE_LIMITS`). The route needs
`content-length`, every write is admitted against the limits first, and a body longer than it declared stores
nothing.

**Attachments are paths.** The composer uploads each picked file to `/uploads/<local date>/` under a name that
replaces nothing there, and the message carries up to eight paths. The runtime refuses a message naming a file that
does not exist, then gives Pi the owner's words, one block listing each file (path, name, size, type) and any App
context, in that order. Pi stores the paths, never the bytes; the agent reads a file when it needs it. The web shows
the files under the message, read back from that block only when every block after the words is one it knows.

**Downloads cannot run.** A download is an attachment with `application/octet-stream`, except PNG, JPEG, GIF and
WebP, which open in place as themselves; every response carries `Content-Security-Policy: default-src 'none';
sandbox` and `nosniff`. An uploaded page never runs on goblin's origin.

**Erasure.** Deleting the account deletes the agent's R2 prefix first, then the object's storage, SQLite and all.
A crash between an R2 write and its row can orphan an object under the prefix; erasure still removes it.

Consequences:
- Files are per agent, not per conversation: every conversation's agent sees the same files.
- Writes use the owner's CSRF rule (`x-goblin-csrf` and the exact Origin), like routines.
- Shell buffers a streamed body before it stores it, so one upload holds up to 25 MiB in the object's memory.
