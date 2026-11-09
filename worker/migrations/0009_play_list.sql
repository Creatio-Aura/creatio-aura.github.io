-- Android testers wait to be added, by hand, to their app's Google Play internal test email list
-- (Andrew, 2026-11-09). NULL = still to add; set when Andrew ticks them off.
ALTER TABLE signups ADD COLUMN play_added_at TEXT;
