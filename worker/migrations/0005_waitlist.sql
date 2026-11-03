-- "Tell me when it's out": one row per person per project in the works. Only the email, the
-- project and what they agreed to are kept: no names, no IP addresses.
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,               -- "effugium", "secessio", "familia-arbor"
  email TEXT NOT NULL,                 -- lower case
  consent_text TEXT NOT NULL,          -- exactly what they agreed to
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,                   -- null until they click the link in the email
  confirm_hash TEXT,                   -- SHA-256 of the confirmation link's token
  confirm_expires TEXT,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project, email)
);
