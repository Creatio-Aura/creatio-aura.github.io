-- Anything a tester wants to tell us when they sign up (e.g. "I'd play on iPhone when it's out").
ALTER TABLE signups ADD COLUMN notes TEXT NOT NULL DEFAULT '';
