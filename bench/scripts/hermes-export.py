"""Read-only consistent export of one completed owner Telegram DM; stdout is private source data."""
import hashlib
import json
import os
import sqlite3
import sys

session_hash = sys.argv[1]
if len(session_hash) != 64 or any(c not in "0123456789abcdef" for c in session_hash):
    raise SystemExit("Supply the full selected session SHA256")
db = sqlite3.connect("file:" + os.path.expanduser("~/.hermes/state.db") + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
db.execute("BEGIN")  # One WAL-aware read transaction binds session metadata and all messages.
sessions = db.execute(
    "SELECT id, source, chat_type, started_at, ended_at, parent_session_id, user_id, chat_id, display_name "
    "FROM sessions WHERE source='telegram' AND chat_type='dm' AND ended_at IS NOT NULL AND parent_session_id IS NULL"
).fetchall()
selected = [s for s in sessions if hashlib.sha256(s["id"].encode()).hexdigest() == session_hash]
if len(selected) != 1:
    raise SystemExit("Selected completed independent DM unavailable")
session = selected[0]
messages = db.execute(
    "SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, "
    "display_kind, active, compacted FROM messages WHERE session_id=? ORDER BY id", (session["id"],)
).fetchall()
snapshot = {
    "schemaVersion": 1, "sessionHash": session_hash, "source": "telegram", "chatType": "dm",
    "startedAt": session["started_at"], "endedAt": session["ended_at"], "parentSessionHash": None,
    "privateIdentifiers": [s for s in (session["user_id"], session["chat_id"], session["display_name"]) if s],
    "messages": [dict(m) for m in messages],
}
db.rollback()
print(json.dumps(snapshot, ensure_ascii=False))
