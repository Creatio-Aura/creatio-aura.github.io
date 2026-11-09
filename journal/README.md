# The Journal

Guides and news from Creatio Aura, at [creatio-aura.com/journal/](https://creatio-aura.com/journal/). Each post is one Markdown file in [posts/](posts/). The publish workflow turns them into pages (with `tools/journal/build.mjs`), so a pull request for a post is just that file: read it, edit it on GitHub if you like, and merge to publish.

- **Guides** answer something people search for, then say how our app does it. **Updates** are news: a test opening, a release, what's next.
- Posts are by **Andrew Bacon, Founder** (decided 2026-11-07).
- One post a day at most, and only ones worth reading: each is read and approved before it goes up.

## A post

File name: `posts/YYYY-MM-DD-the-slug.md`. The slug becomes the address: `/journal/the-slug/`.

```markdown
---
title: Sleep sounds that fade out instead of stopping
description: One or two sentences for search results and link previews, about 120–160 characters.
summary: A shorter line for the Journal list (defaults to the description).
date: 2026-11-08
kind: guide            # guide or update
project: effugium      # effugium, ignis, or studio for the whole company
quick_answer: The answer in two or three sentences, for people who only want that. Guides should have one.
image: /effugium/media/tour-poster.jpg    # optional, a picture from the site
image_alt: What the picture shows
image_link: /effugium/#tour-title          # optional
image_position: center 45%                 # optional: which part of the picture a featured card shows
featured: true         # optional: pins it to the top of the Journal (two at most; the newest two win)
cta_title: Your fan, anywhere              # optional: the closing box's heading, tied to the topic
cta_text: One line on how the app helps with exactly this.
updated: 2026-11-20    # optional, when it's changed later
draft: true            # optional: left out of the site
---

Opening paragraph.

## A section
…

## Questions people ask
### A question someone searches for?
The answer.

## References
- [Apple Support: …](https://support.apple.com/…)
```

The page adds, by itself: the byline and reading time, the quick-answer box, a closing "About the app" box with its buttons, the project's note (information-only for Effugium, trademarks for Ignis), "More from the Journal", the feed and sitemap entries, structured data for search (Article, breadcrumbs, and the questions as FAQ), and the latest three posts on the project's own page.

## A guide's shape (what works for Vaultaire, in our words)

1. A title someone would search, with the year when it's about a current version ("on iPhone (2026)").
2. The quick answer.
3. Sections that walk through it: steps, a short table if comparing, "How to choose" when there are options.
4. How the app does it, plainly, as one way among others.
5. Questions people ask, then a bottom line.
6. References: Apple's or Google's own help pages. Never studies.

## Wording (checked by `tools/journal/check.mjs`)

Say what people can do with the app, never what it does for them: no "relaxing", no better sleep or focus, no anxiety or stress, no medical words, no studies or "research shows". The check stops a pull request that breaks these; read its message, reword, and push again.

## Run it on your Mac

```sh
cd tools/journal
npm ci
npm run check
npm run preview
```

`preview` builds the site with the Journal into `_site/` and serves it at http://127.0.0.1:8080/journal/.

## On launch day

In `tools/journal/config.json`, give the project its `appStore` (`id` and `pt`, the provider token). Every call to action for it then links to the App Store with a campaign name for its spot: `web_j_<slug>` beside the quick answer, `web_jb_<slug>` in the closing box. App Store Connect shows which post and which spot brought each download.

## Bing hears about new posts (IndexNow)

After each publish, `tools/journal/indexnow.mjs` sends the addresses of any post the push added or changed
(plus `/journal/`) to IndexNow, which Bing and a few other search engines share. Google doesn't use it and
finds posts through the sitemap. The key is `site/<key>.txt`: public on purpose, since IndexNow checks the
site hosts it. A failure only shows a warning on the publish run; it never stops the site going live.
Try it without sending anything: `DRY_RUN=1 node tools/journal/indexnow.mjs HEAD~1 HEAD`.
