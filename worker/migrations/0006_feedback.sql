-- Feedback typed into the Ignis Aura app during the beta: what they wrote, the address they gave
-- for a reply (if any), and what the app sent with it (its version, the device, where in the app
-- they were). No IP addresses.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  client_id TEXT UNIQUE,               -- the app's own id for the note, so a resend is kept once
  created_at TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT,                          -- lower case; null if they left none
  details TEXT NOT NULL,               -- JSON: version, build, platform, device, screen, game
  emailed_at TEXT                      -- null until it has gone to the studio's inbox
);
CREATE INDEX feedback_unsent ON feedback (emailed_at);

-- Test mode's outbox keeps where a reply would go, so the tests can check it.
ALTER TABLE outbox ADD COLUMN reply_to TEXT;
