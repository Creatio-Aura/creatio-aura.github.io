// Builds the Journal into a copy of the website: node build.mjs --out <dir>
// Copies site/ to <dir>, then writes /journal/ (the list, one page per post, feed.xml), adds the posts to
// sitemap.xml, and fills each project page's "From the journal" spot. site/ itself is never changed, so a
// day's post is one Markdown file in its pull request; the publish workflow runs this before deploying.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { allPosts, config, esc, longDate, monthOf, rfc822, ROOT, shortDate } from './posts.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
if (outIdx < 0 || !args[outIdx + 1]) {
  console.error('Usage: node build.mjs --out <dir> [--drafts]');
  process.exit(2);
}
const OUT = args[outIdx + 1].startsWith('/') ? args[outIdx + 1] : join(process.cwd(), args[outIdx + 1]);
const withDrafts = args.includes('--drafts');
const SITE = config.site;
const abs = (p) => (p.startsWith('http') ? p : SITE + p);

rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'site'), OUT, { recursive: true });

const posts = allPosts({ drafts: withDrafts });
const project = (p) => config.projects[p.project] || config.projects.studio;
const kindName = (p) => config.kinds[p.kind] || 'Post';
const ctName = (slug) => slug.replace(/-/g, '_');

// A call to action: today the project's own page, with the spot as ?from= for the beta sign-up there; once the app
// is in the App Store, the App Store link with a campaign name (ct) for the spot it's in, so App Store Connect shows
// which post and spot brought a download.
function cta(proj, which, ct, cls) {
  const app = proj.appStore;
  if (which === 'primary' && app && app.id) {
    const href = `https://apps.apple.com/app/apple-store/id${app.id}?pt=${encodeURIComponent(app.pt || '')}&ct=${ct}&mt=8`;
    return `<a class="${cls}" href="${esc(href)}" data-ct="${ct}">${esc(app.label || 'Get it on the App Store')}</a>`;
  }
  const link = proj[which];
  if (!link) return '';
  // On our own pages, the spot goes along as ?from=, so the beta sign-up there records which post and
  // button brought someone (site/beta.js); no analytics.
  let href = link.href;
  if (href.startsWith('/')) {
    const [path, hash] = href.split('#');
    href = `${path}${path.includes('?') ? '&' : '?'}from=${ct}${hash ? '#' + hash : ''}`;
  }
  return `<a class="${cls}" href="${esc(href)}" data-ct="${ct}">${esc(link.label)}</a>`;
}

const BRAND = `<a class="brand" href="/">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><defs><clipPath id="brand-world"><circle cx="20" cy="20" r="17"/></clipPath><linearGradient id="brand-night" x1="0" x2="1"><stop offset="45%" stop-color="#0d0b18" stop-opacity="0.85"/><stop offset="62%" stop-color="#0d0b18" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#brand-world)"><rect width="40" height="40" fill="#1f5c66"/><path d="M7 12c3-4 9-4 11 0s0 6-3 7-2 4-5 6-6 0-6-4-1-5 3-9zM22 8c5-1 11 2 12 7s-3 6-6 6-3 4-1 8-3 6-6 4-3-7-3-12 0-11 4-13zM12 27c4-1 7 2 7 5s-3 5-6 5-5-3-4-6 1-4 3-4z" fill="#ff8a3d"/><rect width="40" height="40" fill="url(#brand-night)"/></g><path d="M20 3a17 17 0 0 1 0 34" fill="none" stroke="#ffd59a" stroke-width="1.6"/></svg>
      Creatio Aura
    </a>`;

function page({ title, description, canonical, ogType, jsonld, body, current }) {
  const img = config.shareImage;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta name="theme-color" content="#120f1f">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="alternate" type="application/rss+xml" title="Creatio Aura Journal" href="${SITE}/journal/feed.xml">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="Creatio Aura">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${abs(img.url)}">
  <meta property="og:image:width" content="${img.width}">
  <meta property="og:image:height" content="${img.height}">
  <meta property="og:image:alt" content="${esc(img.alt)}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..700,100,0&family=Nunito:wght@400;600;700&display=swap">
  <link rel="stylesheet" href="/styles.css">
  <script src="/stars.js" defer></script>
  <script type="application/ld+json">
${JSON.stringify(jsonld, null, 2)}
  </script>
</head>
<body>
  <a class="skip" href="#main">Skip to the content</a>
  <div class="sky" aria-hidden="true"></div>

  <header class="wrap site-header">
    ${BRAND}
    <nav class="site-nav" aria-label="Main">
      <a href="/">All projects</a>
      <a href="/journal/"${current === 'journal' ? ' aria-current="page"' : ''}>Journal</a>
    </nav>
  </header>

  <main id="main">
${body}
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <span>© 2026 Creatio Aura Ltd.</span>
      <nav aria-label="Footer"><a href="/">Home</a><a href="/journal/">Journal</a><a href="/journal/feed.xml">RSS</a><a href="/support/">Support</a><a href="/privacy/">Privacy</a><a href="https://www.linkedin.com/company/creatio-aura/">LinkedIn</a><a href="https://www.facebook.com/creatioaura">Facebook</a><a href="mailto:contact@creatio-aura.com">contact@creatio-aura.com</a></nav>
    </div>
  </footer>
</body>
</html>
`;
}

const authorLd = { '@type': 'Person', name: config.author.name, jobTitle: config.author.jobTitle, worksFor: { '@type': 'Organization', name: config.publisher.name, url: SITE + '/' } };
const publisherLd = { '@type': 'Organization', name: config.publisher.name, url: SITE + '/', logo: { '@type': 'ImageObject', url: abs(config.publisher.logo) } };
const crumbs = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(url ? { item: SITE + url } : {}) })) });

const meta = (p) => `${kindName(p)} · ${esc(project(p).name)}`;
const byline = (p) =>
  `By ${esc(config.author.name)}, ${esc(config.author.jobTitle)} · <time datetime="${p.date}">${longDate(p.date)}</time>` +
  (p.updated !== p.date ? ` · Updated <time datetime="${p.updated}">${longDate(p.updated)}</time>` : '') +
  ` · ${p.minutes} min read`;

function figure(p) {
  if (!p.image) return '';
  const img = `<img src="${esc(p.image)}" alt="${esc(p.image_alt || '')}" loading="lazy">`;
  return `<figure class="post-figure">${p.image_link ? `<a href="${esc(p.image_link)}">${img}</a>` : img}</figure>`;
}

function card(p, cls = 'journal-card') {
  return `<a class="${cls}" href="${p.url}"><span class="journal-tag ${p.kind}">${meta(p)} · ${p.minutes} min</span><span class="journal-title">${esc(p.title)}</span><span class="journal-summary">${esc(p.summary)}</span></a>`;
}

// ---------- one page per post ----------
for (const p of posts) {
  const proj = project(p);
  const ct = ctName(p.slug);
  const more = posts.filter((x) => x !== p).sort((a, b) => (a.project === p.project ? -1 : 0) - (b.project === p.project ? -1 : 0)).slice(0, 3);
  const quick = p.quick_answer
    ? `<aside class="quick-answer" aria-labelledby="qa"><h2 id="qa">Quick answer</h2><p>${esc(p.quick_answer)}</p>${p.kind === 'guide' && proj.primary ? `<p class="quick-cta">${esc(proj.name)} is ours. ${cta(proj, 'primary', `web_j_${ct}`, 'text-link')}</p>` : ''}</aside>`
    : '';
  const ctaBlock = `<aside class="post-cta" aria-labelledby="post-cta-title"><h2 id="post-cta-title">${esc(p.cta_title || 'About ' + proj.name)}</h2><p>${esc(p.cta_text || proj.about)}</p><div class="actions-left">${cta(proj, 'primary', `web_jb_${ct}`, 'button')}${cta(proj, 'secondary', `web_jb2_${ct}`, 'button ghost')}</div></aside>`;
  const body = `    <article class="wrap post">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/journal/">Journal</a> <span aria-hidden="true">/</span> <a href="${esc(proj.page)}">${esc(proj.name)}</a> <span aria-hidden="true">/</span> ${kindName(p)}</nav>
      <p class="eyebrow">${meta(p)}</p>
      <h1>${esc(p.title)}</h1>
      ${p.description ? `<p class="lede">${esc(p.description)}</p>` : ''}
      <p class="byline">${byline(p)}</p>
      ${quick}
      ${figure(p)}
      <div class="post-body">
${p.html}
      </div>
      ${ctaBlock}
      ${proj.note ? `<aside class="note" aria-label="About this post"><p>${proj.note}</p></aside>` : ''}
      ${more.length ? `<section class="journal-more" aria-labelledby="more"><h2 id="more">More from the Journal</h2><div class="journal-grid">${more.map((x) => card(x)).join('')}</div></section>` : ''}
    </article>`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: p.title,
        description: p.description,
        datePublished: p.date,
        dateModified: p.updated,
        author: authorLd,
        publisher: publisherLd,
        image: abs(p.image || config.shareImage.url),
        mainEntityOfPage: SITE + p.url,
        articleSection: kindName(p),
        wordCount: p.words,
      },
      crumbs([
        ['Creatio Aura', '/'],
        ['Journal', '/journal/'],
        [p.title, null],
      ]),
      ...(p.faq.length ? [{ '@type': 'FAQPage', mainEntity: p.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
    ],
  };
  const dir = join(OUT, 'journal', p.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), page({ title: `${p.title} · Creatio Aura`, description: p.description, canonical: SITE + p.url, ogType: 'article', jsonld: ld, body, current: 'journal' }));
}

// ---------- the Journal: a featured post on top, then everything else by month ----------
const featured = posts.find((p) => p.featured) || null;
const rest = posts.filter((p) => p !== featured);
const months = [];
for (const p of rest) {
  const m = monthOf(p.date);
  if (!months.length || months[months.length - 1].name !== m) months.push({ name: m, posts: [] });
  months[months.length - 1].posts.push(p);
}
const indexBody = `    <div class="wrap journal">
      <div class="journal-head">
        <h1>Journal</h1>
        <p class="lede">Guides and news from Creatio Aura, newest first. <a href="/journal/feed.xml">Follow by RSS</a></p>
      </div>
${
  featured
    ? `      <a class="journal-featured" href="${featured.url}">${featured.image ? `<img src="${esc(featured.image)}" alt="${esc(featured.image_alt || '')}">` : ''}<span class="journal-featured-text"><span class="journal-tag ${featured.kind}">Featured · ${meta(featured)}</span><span class="journal-title">${esc(featured.title)}</span><span class="journal-summary">${esc(featured.summary)}</span><span class="journal-date">${longDate(featured.date)} · ${featured.minutes} min read · By ${esc(config.author.name)}</span></span></a>`
    : ''
}
${months
  .map(
    (m, i) => `      <section class="journal-month" aria-labelledby="m${i}"><h2 id="m${i}">${m.name}</h2>
${m.posts.map((p) => `        <a class="journal-row" href="${p.url}"><time datetime="${p.date}">${shortDate(p.date)}</time><span><span class="journal-tag ${p.kind}">${meta(p)} · ${p.minutes} min</span><span class="journal-title">${esc(p.title)}</span><span class="journal-summary">${esc(p.summary)}</span></span></a>`).join('\n')}
      </section>`
  )
  .join('\n')}
${posts.length ? '' : '      <p class="journal-empty">The first posts are on their way.</p>'}
    </div>`;
const indexLd = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'CollectionPage', name: 'Journal', description: 'Guides and news from Creatio Aura.', url: SITE + '/journal/' },
    { '@type': 'ItemList', itemListElement: posts.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE + p.url, name: p.title })) },
    crumbs([
      ['Creatio Aura', '/'],
      ['Journal', null],
    ]),
  ],
};
mkdirSync(join(OUT, 'journal'), { recursive: true });
writeFileSync(join(OUT, 'journal', 'index.html'), page({ title: 'Journal · Creatio Aura', description: 'Guides and news from Creatio Aura: how to get the most from our apps, and what’s new with them.', canonical: SITE + '/journal/', ogType: 'website', jsonld: indexLd, body: indexBody, current: 'journal' }));

// ---------- RSS ----------
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Creatio Aura Journal</title>
    <link>${SITE}/journal/</link>
    <description>Guides and news from Creatio Aura.</description>
    <language>en</language>
    <atom:link href="${SITE}/journal/feed.xml" rel="self" type="application/rss+xml"/>
${posts
  .slice(0, 50)
  .map(
    (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE}${p.url}</link>
      <guid isPermaLink="true">${SITE}${p.url}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <dc:creator>${esc(config.author.name)}</dc:creator>
      <category>${esc(kindName(p))}</category>
      <description>${esc(p.summary)}</description>
    </item>`
  )
  .join('\n')}
  </channel>
</rss>
`;
writeFileSync(join(OUT, 'journal', 'feed.xml'), feed);

// ---------- sitemap ----------
const smPath = join(OUT, 'sitemap.xml');
if (existsSync(smPath)) {
  const newest = posts[0]?.updated || new Date().toISOString().slice(0, 10);
  const urls = [`  <url><loc>${SITE}/journal/</loc><lastmod>${newest}</lastmod></url>`, ...posts.map((p) => `  <url><loc>${SITE}${p.url}</loc><lastmod>${p.updated}</lastmod></url>`)];
  const sm = readFileSync(smPath, 'utf8').replace('</urlset>', `  <!-- The Journal, added by tools/journal/build.mjs -->\n${urls.join('\n')}\n</urlset>`);
  writeFileSync(smPath, sm);
}

// ---------- each project page's "From the journal" spot (<!-- journal:<project> --> in its page) ----------
for (const [key, proj] of Object.entries(config.projects)) {
  const file = join(OUT, proj.page.replace(/^\//, ''), 'index.html');
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  const marker = `<!-- journal:${key} -->`;
  if (!html.includes(marker)) continue;
  const mine = posts.filter((p) => p.project === key).slice(0, 3);
  const block = mine.length
    ? `<section class="wrap journal-strip" aria-labelledby="from-journal"><div class="journal-strip-head"><h2 id="from-journal">From the journal</h2><a href="/journal/">All posts</a></div><div class="journal-grid">${mine.map((p) => card(p)).join('')}</div></section>`
    : '';
  writeFileSync(file, html.replace(marker, block));
}

console.log(`Journal: ${posts.length} post(s) built into ${OUT}${withDrafts ? ' (drafts included)' : ''}`);
