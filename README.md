# Creatio Aura's website

**https://creatio-aura.github.io**: our projects, and beta sign-ups. The first project, code name
**Ignis**, takes beta sign-ups by invite code.

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

## Working on it

- **The website:** open `site/index.html` in a browser, or `python3 -m http.server -d site 8000`.
- **The sign-up service:** `cd worker && npm install && npm test`. Tests run it locally with a
  throwaway database and Cloudflare's test keys; emails go to a test outbox instead of being sent.
- **Publishing the service:** `cd worker && npm run deploy` (applies database changes, then deploys).
- Pull requests into `main`; only Andrew can publish (`main` is protected).
