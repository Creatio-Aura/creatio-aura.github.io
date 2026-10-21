-- The Ignis beta list, and what keeps it safe. Only what people typed is kept: no IP addresses.

CREATE TABLE signups (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,          -- lower case
  name TEXT NOT NULL,
  platforms TEXT NOT NULL,             -- e.g. "iPhone,Web"
  consent_text TEXT NOT NULL,          -- exactly what they agreed to
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,                   -- null until they click the link in the email
  confirm_hash TEXT,                   -- SHA-256 of the confirmation link's token
  confirm_expires TEXT,
  leave_hash TEXT NOT NULL,            -- SHA-256 of the remove-me link's token
  emails_sent INTEGER NOT NULL DEFAULT 0,
  last_email_at TEXT
);

-- Rate limits: how many tries per hour from one connection (an anonymous, salted hash, never
-- the address itself), and how many emails per day in all.
CREATE TABLE attempts (
  kind TEXT NOT NULL,
  hour INTEGER NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (kind, hour, key)
);

-- Test mode only: emails are kept here instead of sent.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
