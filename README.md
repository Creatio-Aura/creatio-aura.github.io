# Creatio Aura's website

**https://creatio-aura.com**: our projects, and beta sign-ups for **Ignis Aura** and **Effugium
Aura** (no invite code since 7 November 2026: anyone can sign up, and Andrew lets each one in).

## What's here

| Folder                      | What it is                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `site/`                     | The website: plain HTML and CSS. Published to GitHub Pages whenever `main` changes.                         |
| `journal/`                  | The Journal: one Markdown file per post ([journal/README.md](journal/README.md)).                           |
| `tools/journal/`            | Builds the Journal into the site when it's published, and checks posts' wording on every pull request.      |
| `worker/`                   | The beta sign-up service, a Cloudflare Worker with a D1 database (the list).                                |
| `.github/workflows/ci.yml`  | Every pull request: the sign-up service's type check and tests, and the Journal's check and build.         |
| `.github/workflows/pages.yml` | Builds the Journal into `site/` and publishes it on every change to `main`.                               |
| `.github/workflows/security-txt.yml` | Monthly: fails once `site/.well-known/security.txt` is under 60 days from expiring.          |

**Search engines and AI assistants.** `site/robots.txt` welcomes both (with `Content-Signal: search=yes,
ai-input=yes, ai-train=yes`, Andrew 2026-11-07) and points them at `site/sitemap.xml`, which lists the pages to
index: **add new pages there** (the Journal adds its own posts when it builds). Pages that shouldn't appear in results (the beta's confirmed/left/
expired pages, 404, `ignis-aura-web/`) say `noindex` themselves. Indexed pages name their canonical
creatio-aura.com address, and the home page carries the company's details for search engines
(name, legal name "Creatio Aura Ltd.", logo, contact email and the business phone; no postal
address, on purpose). `/support/` is the Support URL for App Store and Google Play listings.

## Waiting lists ("tell me when it's out")

Each project in the works has its own page (`site/effugium/`, `site/secessio/`, `site/familia-arbor/`)
with a sign-up for its waiting list: an email, consent and the Turnstile check. **No invite code**,
so the human check, the decoy field and the rate limits do the guarding. The same service sends a
confirmation link (48 hours); confirming sends a "You're on the list" email with a button to leave,
and lands on `/waitlist/confirmed/`. Only the email, the project and the consent are kept (table
`waitlist`, `worker/migrations/0005_waitlist.sql`); unconfirmed rows go after 7 days. The daily
report shows each list's size, and `npm run waitlist` lists them. The projects are named in
`worker/src/waitlist.ts` (`PROJECTS`); a new one needs its page, an entry there, and one in the
confirmed page's script. Nothing sends the launch email yet: that's for when a project ships.

## Feedback from the Ignis Aura app

During the beta, testers type feedback into the app (its menu → Send feedback) and it comes here:
`POST /feedback` (`worker/src/feedback.ts`). The service keeps it (table `feedback`,
`worker/migrations/0006_feedback.sql`) and emails it to `FEEDBACK_EMAIL` (feedback@creatio-aura.com,
in `wrangler.toml`; `OWNER_EMAIL` if that's not set), with the app's version, the
device and the screen. If the tester left an address, the email's Reply-To is them, so replying
answers them, and it says whether they're on the beta list. An app on a phone sends no Origin, so
this route alone takes requests without one; from a browser, only the allowed origins (the web
build's among them). There's no invite code or human check in the app, so limits guard it: 10 per
connection an hour, 300 kept a day, 60 emailed a day. A note over that is kept, and emailed with
the next one or the next morning. The app sends its own id with each note, so one it sends again
(offline, it keeps them until it's back online) is kept once. `npm run feedback` lists the latest,
and the daily report counts them.

## How a beta sign-up works

Both betas (`worker/src/betas.ts`: Ignis Aura's on `/ignis/`, Effugium Aura's on `/effugium/`) share
one sign-up, `site/beta.js`; the form's `data-project` says which.

1. **The form:** email, where they'd play (Effugium Aura has no Web), consent, and Cloudflare
   **Turnstile** (the "are you human" check). A hidden decoy field catches bots, and sign-ups are
   limited per connection. There's no invite code any more.
2. **A confirmation email** from support@creatio-aura.com, sent through IONOS. Only people who click
   its link (within 48 hours) go further; unconfirmed sign-ups are deleted after 7 days.
3. **Andrew lets them in.** Confirming emails `OWNER_EMAIL` ("… wants in"), with a link to a page with
   two buttons: **Let them in** or **Turn them away** (`worker/src/approve.ts`; the link only opens
   the page, so mail apps that check links can't let anyone in). The morning report lists everyone
   waiting, with the same links. Until they're let in, they can't open the web game or get build
   emails. For Android, add their Google account to the Play test's testers first.
4. **"You're in":** letting them in emails them, with the latest links for where they play (the ones
   the last announcement sent) and, for Ignis Aura, the Beta Tester Terms in short. Turning them
   away deletes them, and they hear nothing. Every email has a remove-me link, which deletes them
   at once.

**What's kept:** email, the beta, platforms, what they agreed to and when, when they were let in, and
**where the sign-up came from** as a short label (testers from before 7 November also gave a name and notes).
The label is the `?from=` a link put on the page (the Journal's buttons send `web_jb_<post>`), else the
site they arrived from (`ref_google`, `ref_journal_<post>`), else `direct`; never a full address. Kept from
the first sign-up. `npm run testers` counts sign-ups by it: our own measure of which pages bring testers,
instead of analytics (Andrew, 2026-11-07). **No IP addresses**: rate limits use a
salted, anonymous fingerprint, cleared within two days. The list lives in the D1 database on
Creatio Aura's Cloudflare account, and only that account can read it. This repo is public, but it
holds only code, never sign-ups or secrets. See `site/privacy/`.

## The secrets (never in this repo)

Set once with `npx wrangler secret put <NAME>` in `worker/`:

| Secret               | What it is                                                                        |
| -------------------- | --------------------------------------------------------------------------------- |
| `INVITE_CODE`        | No longer used (the invite code went on 7 November 2026): `npx wrangler secret delete INVITE_CODE`. |
| `TURNSTILE_SECRET`   | Turnstile's secret key (its public site key is in `site/ignis/index.html`).      |
| `SMTP_PASSWORD`      | The support@creatio-aura.com mailbox's password (IONOS), so the service can send email. |
| `PASS_SECRET`        | A long random string that signs the remove-me and let-them-in links.             |
| `IP_SALT`            | A long random string for the anonymous rate-limit fingerprints.                  |

## Reading the list

Only from the Cloudflare account: **Workers & Pages → D1 → creatio-aura-beta → Console**, or
from this folder:

```
cd worker
npx wrangler d1 execute creatio-aura-beta --remote --command \
  "SELECT project, email, platforms, approved_at FROM signups WHERE approved_at IS NOT NULL ORDER BY project, approved_at"
```

## The tools: who's signed up, and sending builds

You'll get an email at creatio.aura@gmail.com each time someone **confirms**: which beta, their
email and where they play, and the link to let them in. And **every morning** (14:00 UTC: 8 am in
Colorado in summer, 7 am in winter) a report: everyone waiting for your OK (with the links), and for
each beta who's been let in since the last report, everyone in it with where they play, totals per
platform, and how many are still to confirm. It goes to `REPORT_EMAIL` if that's set
(`wrangler.toml`), otherwise to `OWNER_EMAIL`.

From `worker/` (they need the admin key, below):

```
npm run testers          # everyone in each beta, with where they play, and who's waiting for your OK
npm run waitlist         # everyone confirmed on each project's waiting list
npm run feedback         # the latest feedback from the app, newest first
npm run report           # the daily report, shown here; add -- --send to email it now

# Email a beta's testers a new build: each gets only the links for the platforms they play on.
# Without --send it only shows who'd get what, and the email. Once sent, those links are the
# beta's latest: testers let in later get them in their welcome.
npm run announce -- --title "Ignis Aura 0.6.0 is ready" \
  --message "What's new: the digital board. Tell us what you think by replying." \
  --android https://play.google.com/apps/internaltest/… --iphone https://testflight.apple.com/join/… --web
npm run announce -- …the same… --send
npm run announce -- --project effugium --title "…" --message "…" --iphone … --android …   # Effugium Aura's
```

`--web` on its own means https://creatio-aura.com/ignis-aura-web/. An `--android` link to Google
Play gets Play's instructions; an APK link, the sideloading ones. `--message-file note.txt`
reads a longer note (blank lines make paragraphs). Every email has the tester's remove-me link,
and the day's email allowance (400) still applies: anyone over it is listed to send tomorrow.

**The admin key** is a long random string kept in two places only: the service's `ADMIN_TOKEN`
secret, and `worker/.admin-token` on your computer (never in git). To change it, put a new one in
both.

## How testers get each build

- **Web:** a link; it opens in any browser. Nothing to install.
- **Android:** the Google Play test's join link (internal testing). It only lets in the Google
  accounts on the test's tester list, so add each tester's (Play Console → Testing → Testers) when
  you let them in. An APK link from the Expo build page still works for sideloading; both are
  signed with the same key, so Play's copy updates a sideloaded one.
- **iPhone (and iPad):** the TestFlight public link. Testers install TestFlight from the App Store,
  then open the link.

## Working on it

- **The website:** open `site/index.html` in a browser, or `python3 -m http.server -d site 8000`.
- **The sign-up service:** `cd worker && npm install && npm test`. Tests run it locally with a
  throwaway database and Cloudflare's test keys; emails go to a test outbox instead of being sent.
- **Publishing the service:** `cd worker && npm run deploy` (applies database changes, then deploys).
- Pull requests into `main`; only Andrew can publish (`main` is protected).

## The domain

**creatio-aura.com** is registered at IONOS, which also runs its DNS and the company email. The site
itself is still GitHub Pages: the domain points there, and the repo's Pages settings name it as the
custom domain (creatio-aura.github.io forwards to it). In IONOS (Domains & SSL → creatio-aura.com →
DNS):

- `@` A: 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153
- `@` AAAA: 2606:50c0:8000::153, 2606:50c0:8001::153, 2606:50c0:8002::153, 2606:50c0:8003::153
- `www` CNAME: creatio-aura.github.io
- `_github-pages-challenge-creatio-aura` TXT: verifies the domain for the Creatio-Aura organisation
- The MX, SPF (`v=spf1`), `_dmarc`, `_domainkey` and `autodiscover` records are IONOS's "Mail" service:
  leave them alone. (IONOS's "Default Site" service, its parking page, was turned off for the move.)

**Email addresses** (IONOS Mail Basic; each forwards to creatio.aura@gmail.com with its own `+label`,
e.g. `creatio.aura+support@gmail.com`): contact@ (the site's footer and invite requests), privacy@
(the privacy policy), legal@ (the beta terms), security@ (`site/.well-known/security.txt`),
support@ (the sign-up service sends as it, through IONOS's `smtp.ionos.com`, so testers' replies
land there), billing@, owner@, feedback@ (feedback from the app, `FEEDBACK_EMAIL`), and the
standard postmaster@ and abuse@. The service's other notifications go straight to
creatio.aura@gmail.com (`OWNER_EMAIL`).

**`security.txt` expires on 31 October 2027.** Move its `Expires` date on before then (at most a year
ahead), or security researchers may treat it as out of date. The **security.txt date** workflow checks
it on the 1st of every month and fails, which emails Andrew, once it's under 60 days away. GitHub pauses
scheduled runs in a public repo after 60 days without commits: if that happens, turn it back on from
the Actions tab.
