-- Guest creators: friends Andrew invites to write scenarios in the online creator, with a code
-- instead of a GitHub account. What they write waits here for his review.
CREATE TABLE guests (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL REFERENCES guests(code),
  title TEXT NOT NULL,
  where_json TEXT NOT NULL,
  encounter_json TEXT NOT NULL,
  -- submitted, changes (Andrew asked for changes), approved, declined
  status TEXT NOT NULL DEFAULT 'submitted',
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX submissions_by_code ON submissions(code);
