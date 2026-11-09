-- Sending at IONOS's pace (2026-11-09: "Mail send limit exceeded" after a quick burst). Emails wait
-- here when they're part of a batch, when the hourly budget is used up, or when the mail server said
-- "not now" (4xx); a job every minute sends what's due, within the budget. Rows go once sent.
CREATE TABLE mail_queue (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,                 -- the whole email, as JSON
  to_addr TEXT NOT NULL,               -- for the admin view and the morning report
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  next_try_at TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  failed_at TEXT                       -- set when the mail server said no for good (5xx)
);
CREATE INDEX mail_queue_due ON mail_queue (failed_at, next_try_at);

-- Every hand-off to the mail server, kept two days, for the hourly budget. No addresses.
CREATE TABLE mail_log (
  at TEXT NOT NULL,
  ok INTEGER NOT NULL                  -- 1 accepted, 0 turned away for now, -1 turned away for good
);
CREATE INDEX mail_log_at ON mail_log (at);
