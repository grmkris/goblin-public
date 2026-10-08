/** Application-owned external-content index, with the exact migration statement separator goblin uses. */
export const transcriptDDL = [
  `CREATE TABLE app_transcript_excerpts (entry_id INTEGER PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL, role TEXT NOT NULL, author TEXT, at INTEGER NOT NULL, text TEXT NOT NULL)`,
  'CREATE INDEX app_transcript_excerpts_chat ON app_transcript_excerpts (chat_id, entry_id)',
  "CREATE VIRTUAL TABLE app_transcript_fts USING fts5(text, content='app_transcript_excerpts', content_rowid='entry_id')",
  'CREATE TABLE app_transcript_index (session_id TEXT PRIMARY KEY NOT NULL, through_entry INTEGER NOT NULL)',
  `CREATE TRIGGER app_transcript_ai AFTER INSERT ON app_transcript_excerpts BEGIN
    INSERT INTO app_transcript_fts(rowid, text) VALUES (new.entry_id, new.text); END`,
  `CREATE TRIGGER app_transcript_ad AFTER DELETE ON app_transcript_excerpts BEGIN
    INSERT INTO app_transcript_fts(app_transcript_fts, rowid, text) VALUES ('delete', old.entry_id, old.text); END`,
  `CREATE TRIGGER app_transcript_au AFTER UPDATE ON app_transcript_excerpts BEGIN
    INSERT INTO app_transcript_fts(app_transcript_fts, rowid, text) VALUES ('delete', old.entry_id, old.text);
    INSERT INTO app_transcript_fts(rowid, text) VALUES (new.entry_id, new.text); END`,
]
