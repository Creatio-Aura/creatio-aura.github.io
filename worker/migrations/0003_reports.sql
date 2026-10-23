-- When each daily report was sent, so the next one counts the testers new since then.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  sent_at TEXT NOT NULL
);
