-- Where each beta sign-up came from (2026-11-07, Andrew: count it ourselves, no analytics): a short code
-- the form sends, like "web_jb_effugium_aura_is_in_testing" (the Journal post and button that led there)
-- or "ref_google" (the site a visitor arrived from). Kept from the first sign-up; never an address or a
-- full link. The testers report counts sign-ups by it.
ALTER TABLE signups ADD COLUMN source TEXT NOT NULL DEFAULT '';
