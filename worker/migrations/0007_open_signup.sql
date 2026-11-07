-- The betas without an invite code (2026-11-07). Anyone can sign up with their email and where
-- they'd play; confirming by email puts them in line, and Andrew lets each one in. Until then they
-- can't open the web game or get build emails. One list, for each app with a beta: Ignis Aura
-- ("ignis") and Effugium Aura ("effugium"), so one address can sign up for both.
--
-- SQLite can't change a table's unique key in place, so the list is copied into a new table:
-- every row keeps its id (the remove-me links are signed ids), and everyone confirmed before is in.
CREATE TABLE signups_new (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'ignis', -- which app's beta
  email TEXT NOT NULL,                 -- lower case
  name TEXT NOT NULL DEFAULT '',       -- only testers from before 7 November 2026 gave one
  platforms TEXT NOT NULL,             -- e.g. "iPhone,Web"
  notes TEXT NOT NULL DEFAULT '',      -- likewise
  consent_text TEXT NOT NULL,          -- exactly what they agreed to
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,                   -- null until they click the link in the email
  confirm_hash TEXT,                   -- SHA-256 of the confirmation link's token
  confirm_expires TEXT,
  leave_hash TEXT NOT NULL,            -- SHA-256 of the remove-me link's token (links before they were signed)
  emails_sent INTEGER NOT NULL DEFAULT 0,
  last_email_at TEXT,
  approved_at TEXT,                    -- null until Andrew lets them in
  UNIQUE (project, email)
);
INSERT INTO signups_new (id, project, email, name, platforms, notes, consent_text, consent_at, created_at,
    confirmed_at, confirm_hash, confirm_expires, leave_hash, emails_sent, last_email_at, approved_at)
  SELECT id, 'ignis', email, name, platforms, notes, consent_text, consent_at, created_at,
    confirmed_at, confirm_hash, confirm_expires, leave_hash, emails_sent, last_email_at, confirmed_at
  FROM signups;
DROP TABLE signups;
ALTER TABLE signups_new RENAME TO signups;
CREATE INDEX signups_confirm ON signups (confirm_hash);

-- The latest build link for each app and platform, kept when an announcement is sent, so a tester
-- let in later gets the links straight away.
CREATE TABLE builds (
  project TEXT NOT NULL,
  platform TEXT NOT NULL,              -- "iPhone", "Android", "Web"
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project, platform)
);
