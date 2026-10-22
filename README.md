# Creatio Aura's website

**https://creatio-aura.github.io**: our projects, and beta sign-ups. The first project,
**Ignis Aura**, takes beta sign-ups by invite code.

## What's here

| Folder                      | What it is                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `site/`                     | The website: plain HTML and CSS, no build step. Published to GitHub Pages whenever `main` changes.        |
| `worker/`                   | The beta sign-up service, a Cloudflare Worker with a D1 database (the list).                                |
| `.github/workflows/ci.yml`  | Every pull request: the sign-up service's type check and tests.                                            |
| `.github/workflows/pages.yml` | Publishes `site/` on every change to `main`.                                                              |

## How a beta sign-up works

1. **The invite code.** Someone enters the code you gave them, and passes Cloudflare **Turnstile**
   (the "are you human" check). The service checks both and hands back a pass that unlocks the
   form for 30 minutes. Wrong codes are limited to a few tries an hour per connection.
2. **Their details:** name, email, where they'd play, and consent. A hidden decoy field catches
   bots. Sign-ups are limited per connection too.
3. **A confirmation email** from creatio.aura@gmail.com, sent through Gmail. Only people who click
   its link (within 48 hours) join the list; unconfirmed sign-ups are deleted after 7 days. Every
   email has a remove-me link, which deletes them at once.

**What's kept:** name, email, platforms, what they agreed to and when. **No IP addresses**: rate
limits use a salted, anonymous fingerprint, cleared within two days. The list lives in the D1
database on Creatio Aura's Cloudflare account, and only that account can read it. This repo is
public, but it holds only code, never sign-ups or secrets. See `site/privacy/`.

## The secrets (never in this repo)

Set once with `npx wrangler secret put <NAME>` in `worker/`:

| Secret               | What it is                                                                        |
| -------------------- | --------------------------------------------------------------------------------- |
| `INVITE_CODE`        | The code you share, e.g. `WORD-WORD-WORD-WORD-0000`. Change it any time to retire the old one. |
| `TURNSTILE_SECRET`   | Turnstile's secret key (its public site key is in `site/ignis/index.html`).      |
| `GMAIL_APP_PASSWORD` | A Gmail app password for creatio.aura@gmail.com, so the service can send email.  |
| `PASS_SECRET`        | A long random string that signs the 30-minute passes.                            |
| `IP_SALT`            | A long random string for the anonymous rate-limit fingerprints.                  |

## Reading the list

Only from the Cloudflare account: **Workers & Pages → D1 → creatio-aura-beta → Console**, or
from this folder:

```
cd worker
npx wrangler d1 execute creatio-aura-beta --remote --command \
  "SELECT name, email, platforms, confirmed_at FROM signups WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at"
```

## The tools: who's signed up, and sending builds

You'll get an email at creatio.aura@gmail.com each time someone **confirms**: their name, email
and where they play, and how many testers there are now.

From `worker/` (they need the admin key, below):

```
npm run testers          # everyone confirmed, with where they play, and totals per platform

# Email testers a new build: each gets only the links for the platforms they play on.
# Without --send it only shows who'd get what, and the email.
npm run announce -- --title "Ignis Aura 0.6.0 is ready" \
  --message "What's new: the digital board. Tell us what you think by replying." \
  --android https://expo.dev/artifacts/eas/….apk --web
npm run announce -- …the same… --send
```

`--web` on its own means https://creatio-aura.github.io/ignis-aura-web/. `--message-file note.txt`
reads a longer note (blank lines make paragraphs). Every email has the tester's remove-me link,
and the day's email allowance (400) still applies: anyone over it is listed to send tomorrow.

**The admin key** is a long random string kept in two places only: the service's `ADMIN_TOKEN`
secret, and `worker/.admin-token` on your computer (never in git). To change it, put a new one in
both.

## How testers get each build

- **Web:** a link; it opens in any browser. Nothing to install.
- **Android:** the install link from the Expo build page (`npx eas-cli build -p android --profile
  preview` in the game repo makes one). On their phone they open it, download the app, allow
  installing from their browser when asked, and press Install. Later builds install over it and
  keep their games, since every build is signed with the same key.
- **iPhone:** needs the Apple Developer Program (TestFlight). Until then, iPhone testers play the
  web version.

## Working on it

- **The website:** open `site/index.html` in a browser, or `python3 -m http.server -d site 8000`.
- **The sign-up service:** `cd worker && npm install && npm test`. Tests run it locally with a
  throwaway database and Cloudflare's test keys; emails go to a test outbox instead of being sent.
- **Publishing the service:** `cd worker && npm run deploy` (applies database changes, then deploys).
- Pull requests into `main`; only Andrew can publish (`main` is protected).
