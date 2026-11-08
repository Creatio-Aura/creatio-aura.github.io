// Checks every Journal post before it's published: node check.mjs [file ...]
// Errors stop the pull request; warnings are printed for a person to look at. The wording rules are the ones
// for Effugium Aura's store listing, app and website (2026-11-06): say what people can do with it, never
// what it does for them; no medical claims; no studies cited.
import { readdirSync } from 'node:fs';
import { config, POSTS, readPost } from './posts.mjs';

const files = process.argv.slice(2).length ? process.argv.slice(2).map((f) => f.split('/').pop()) : readdirSync(POSTS).filter((f) => f.endsWith('.md'));

// Outcomes and health claims. Each is a pattern and why it's out.
const BANNED = [
  [/\brelax(es|ed|ing|ation)?\b/i, 'an outcome ("relax"): say what people can do instead'],
  [/\b(calm(s|er|ing)? (you|your mind)|soothe[sd]?|soothing)\b/i, 'an outcome (calms or soothes you)'],
  [/\b(anxiety|anxious|stress relief|reduces? stress|less stress)\b/i, 'a health claim (stress or anxiety)'],
  [/\b(insomnia|sleep disorder|tinnitus|adhd|ptsd|depression)\b/i, 'a medical condition'],
  [/\b(cure[sd]?|treat(s|ed|ment)?|therap(y|ies|eutic)|heal(s|ing)?|clinical(ly)?|diagnos\w*)\b/i, 'a medical word'],
  [/\b(sleep better|better sleep|deeper sleep|sleep deeper|fall asleep faster|faster sleep|improves? (your )?sleep|sleep quality)\b/i, 'a sleep outcome'],
  [/\b(improves? (your )?focus|boosts? (focus|productivity)|meditate deeply|deeper meditation)\b/i, 'a focus or meditation outcome'],
  [/\b(helps? you (lucid )?dream|induces? lucid|guarantee[sd]?)\b/i, 'a promised result'],
  [/\b(studies|study shows|research (shows|proves|suggests)|scientifically|proven)\b/i, 'studies or proof: we don’t cite research'],
];
// Allowed on purpose: the information-only note's own wording.
const ALLOW = [/not a medical device/i, /isn['’]t medical advice/i, /makes no health claims/i];
const STUDY_HOSTS = /(doi\.org|pubmed|ncbi\.nlm\.nih\.gov|sciencedirect|springer|wiley\.com|nature\.com\/articles|jamanetwork|thelancet|nih\.gov)/i;

let errors = 0;
let warnings = 0;
const err = (f, m) => {
  errors++;
  console.log(`ERROR  ${f}: ${m}`);
};
const warn = (f, m) => {
  warnings++;
  console.log(`warn   ${f}: ${m}`);
};

for (const f of files) {
  let p;
  try {
    p = readPost(f);
  } catch (e) {
    err(f, e.message);
    continue;
  }
  for (const k of ['title', 'description', 'kind', 'project']) if (!p[k]) err(f, `front matter needs "${k}"`);
  if (p.kind && !config.kinds[p.kind]) err(f, `kind must be one of: ${Object.keys(config.kinds).join(', ')}`);
  if (p.project && !config.projects[p.project]) err(f, `project must be one of: ${Object.keys(config.projects).join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) err(f, 'date must look like 2026-11-07');
  if (p.date !== p.fileDate) warn(f, `the file name says ${p.fileDate} but date says ${p.date}`);
  if (p.title && p.title.length > 70) warn(f, `title is ${p.title.length} characters; search results cut off around 60`);
  if (p.description && (p.description.length < 70 || p.description.length > 165)) warn(f, `description is ${p.description.length} characters; aim for 120–160`);
  if (p.kind === 'guide' && !p.quick_answer) warn(f, 'a guide should start with a quick_answer');
  if (p.image && !p.image_alt) err(f, 'image needs image_alt (what it shows, for people who can’t see it)');
  if (/<script|\son\w+\s*=|javascript:/i.test(p.body)) err(f, 'no scripts or inline event handlers in posts');
  if (/^#\s/m.test(p.body)) err(f, 'don’t use a single # heading: the title is the page’s heading; start sections at ##');

  const text = [...new Set([p.title, p.description, p.summary, p.quick_answer, p.cta_title, p.cta_text].filter(Boolean)), p.body].join('\n');
  for (const line of new Set(text.split('\n'))) {
    // The allowed phrases are taken out of the line, not the whole line skipped.
    const checked = ALLOW.reduce((l, a) => l.replace(new RegExp(a.source, 'gi'), ' '), line);
    for (const [re, why] of BANNED) {
      const m = checked.match(re);
      if (m) err(f, `"${m[0]}" (${why}) in: ${line.trim().slice(0, 100)}`);
    }
  }
  for (const m of p.body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (STUDY_HOSTS.test(m[1])) err(f, `links to a study or journal (${m[1]}): we don’t cite research`);
}

console.log(`\n${files.length} post(s) checked: ${errors} error(s), ${warnings} warning(s).`);
process.exit(errors ? 1 : 0);
