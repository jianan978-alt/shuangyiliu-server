// db.js — SQLite database layer (better-sqlite3, synchronous & fast for this scale)
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, "app.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
// discipline: 'chem' | 'chem_eng'
// indicator_id: e.g. 'IND001' (matches indicators.json)
// item_idx: index into indicator.items[] for text fields; NULL for indicator-level rows
db.exec(`
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discipline TEXT NOT NULL,
  indicator_id TEXT NOT NULL,
  item_idx INTEGER NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(discipline, indicator_id, item_idx)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discipline TEXT NOT NULL,
  indicator_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('evidence','list')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fields_lookup ON fields(discipline, indicator_id);
CREATE INDEX IF NOT EXISTS idx_files_lookup ON files(discipline, indicator_id, kind);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discipline TEXT NOT NULL,
  person TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
