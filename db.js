'use strict';
// SQLite via Node's built-in node:sqlite (Node >= 22.5) — no native dependencies.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const file = process.env.DATABASE_FILE
  ? path.resolve(process.env.DATABASE_FILE)
  : path.join(__dirname, '..', 'data', 'eventcheck.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'organizer' CHECK (role IN ('organizer','admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  venue TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  organizer_name TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  image_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  registration_open INTEGER NOT NULL DEFAULT 1,
  custom_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id, date);
CREATE INDEX IF NOT EXISTS idx_events_public ON events(status, date);

CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attendee_id TEXT NOT NULL UNIQUE,
  attendee_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  custom_answers TEXT NOT NULL DEFAULT '{}',
  qr_token TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','cancelled')),
  UNIQUE (event_id, email)
);
CREATE INDEX IF NOT EXISTS idx_reg_event ON registrations(event_id, registered_at);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  attendee_id TEXT NOT NULL,
  checked_in_at TEXT NOT NULL,
  checked_in_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'checked_in'
);
CREATE INDEX IF NOT EXISTS idx_checkins_event ON checkins(event_id, checked_in_at);
`);

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
module.exports = { db, uid, now, tx };
