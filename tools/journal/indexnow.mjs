// Tells Bing (and the other search engines that share IndexNow) about Journal posts a push added or
// changed, right after the site is published, so they show up there in days rather than weeks.
// Google doesn't use IndexNow; it finds new posts through the sitemap.
//
//     node indexnow.mjs <commit before the push> <commit after it>
//     DRY_RUN=1 node indexnow.mjs <before> <after>      print what would be sent, send nothing
//
// The key is the file site/<32 hex characters>.txt. It's public on purpose: IndexNow checks that the site
// hosts it, which proves the request comes from the site's owner. This never fails the publish: any
// problem is printed as a warning and the script exits 0.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { allPosts } from './posts.mjs';

const ENDPOINT = 'https://api.indexnow.org/indexnow';
const root = new URL('../../', import.meta.url).pathname;
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const site = config.site.replace(/\/$/, '');
const warn = (message) => {
  console.log(`::warning::IndexNow: ${message}`);
  process.exit(0);
};

const keyFile = readdirSync(join(root, 'site')).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) warn('no key file in site/.');
const key = readFileSync(join(root, 'site', keyFile), 'utf8').trim();

const [before, after = 'HEAD'] = process.argv.slice(2);
if (!before || /^0+$/.test(before)) warn('no earlier commit to compare with, so nothing to send.');

let changed = [];
try {
  changed = execFileSync('git', ['-C', root, 'diff', '--name-only', '--diff-filter=AMR', before, after, '--', 'journal/posts'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.md'))
    .map((f) => basename(f));
} catch (error) {
  warn(`couldn't compare ${before} with ${after} (${error.message.split('\n')[0]}).`);
}

// Only posts that are actually published (drafts are left out of the site).
const published = new Map(allPosts().map((p) => [p.file, p]));
const urls = changed.filter((f) => published.has(f)).map((f) => site + published.get(f).url);
if (urls.length === 0) {
  console.log('IndexNow: no new or changed Journal posts in this push.');
  process.exit(0);
}
urls.push(`${site}/journal/`);

const body = { host: new URL(site).host, key, keyLocation: `${site}/${keyFile}`, urlList: urls };
if (process.env.DRY_RUN === '1') {
  console.log('IndexNow (dry run) would send:\n' + JSON.stringify(body, null, 2));
  process.exit(0);
}
try {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  // 200: accepted. 202: accepted, key still being checked. Anything else: worth a look, never a failure.
  if (res.status === 200 || res.status === 202) console.log(`IndexNow: sent ${urls.length} address(es) (${res.status}):\n${urls.join('\n')}`);
  else warn(`answered ${res.status} ${await res.text().catch(() => '')}`.trim());
} catch (error) {
  warn(`couldn't reach ${ENDPOINT} (${error.message}).`);
}

function join(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}
