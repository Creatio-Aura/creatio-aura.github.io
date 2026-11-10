-- Who left a beta, counted without who they were (Andrew, 2026-11-10: "is there a way to start tracking any
-- unsubscribes"). Leaving still deletes the sign-up (their email and name go); this keeps only which beta,
-- the platforms they'd picked, how they came, whether they'd been let in, and when they joined and left.
CREATE TABLE departures (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  platforms TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  was_in INTEGER NOT NULL,             -- 1 if Andrew had let them in
  joined_at TEXT NOT NULL,
  left_at TEXT NOT NULL
);
