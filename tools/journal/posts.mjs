// Reads the Journal's posts: journal/posts/YYYY-MM-DD-the-slug.md, a small front matter block between
// "---" lines, then Markdown. See journal/README.md for the fields.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

export const ROOT = new URL('../../', import.meta.url).pathname;
export const POSTS = join(ROOT, 'journal/posts');
export const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

const FIELDS = ['title', 'description', 'summary', 'date', 'updated', 'kind', 'project', 'featured', 'draft', 'quick_answer', 'image', 'image_alt', 'image_link', 'image_position', 'cta_title', 'cta_text'];

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// "key: value" lines; values may be quoted. Booleans for featured and draft.
function frontMatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no front matter (a block between --- lines at the top)`);
  const data = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: can't read front matter line "${line}"`);
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v === 'true' ? true : v === 'false' ? false : v;
  }
  return { data, body: m[2] };
}

// A post's questions and answers, from a "## Questions people ask" (or "FAQ") section: each "### question"
// and the text under it, for the FAQPage data.
function faqOf(tokens) {
  const out = [];
  let inFaq = false;
  let q = null;
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 2) {
      inFaq = /^(questions people ask|frequently asked questions|faq|questions)$/i.test(t.text.trim());
      q = null;
      continue;
    }
    if (!inFaq) continue;
    if (t.type === 'heading' && t.depth === 3) {
      q = { q: t.text.trim(), a: '' };
      out.push(q);
    } else if (q && (t.type === 'paragraph' || t.type === 'list')) {
      q.a += (q.a ? ' ' : '') + t.raw.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    }
  }
  return out.filter((x) => x.a);
}

// Markdown to HTML, with an id on each h2 and h3 so sections can be linked.
function render(md) {
  const html = marked.parse(md, { gfm: true });
  const used = new Set();
  return html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, n, inner) => {
    let id = slugify(inner) || 'section';
    while (used.has(id)) id += '-2';
    used.add(id);
    return `<h${n} id="${id}">${inner}</h${n}>`;
  });
}

export function readPost(file) {
  const name = file.replace(/\.md$/, '');
  const m = name.match(/^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)$/);
  if (!m) throw new Error(`${file}: name it YYYY-MM-DD-the-slug.md (lower case, hyphens)`);
  const text = readFileSync(join(POSTS, file), 'utf8').replace(/\r\n/g, '\n');
  const { data, body } = frontMatter(text, file);
  const unknown = Object.keys(data).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new Error(`${file}: unknown front matter field(s): ${unknown.join(', ')}`);
  // Which part of the picture a featured card shows when it's cropped, e.g. "center 45%" (CSS object-position).
  const POS = /^(top|center|bottom|left|right|\d{1,3}%)( (top|center|bottom|left|right|\d{1,3}%))?$/;
  if (data.image_position !== undefined && !POS.test(String(data.image_position))) throw new Error(`${file}: image_position must look like "center 45%" or "top"`);
  const tokens = marked.lexer(body, { gfm: true });
  const words = body.replace(/[#*_>`\[\]()-]/g, ' ').split(/\s+/).filter(Boolean).length + String(data.quick_answer || '').split(/\s+/).length;
  return {
    file,
    slug: m[2],
    fileDate: m[1],
    ...data,
    date: data.date || m[1],
    updated: data.updated || data.date || m[1],
    featured: data.featured === true,
    draft: data.draft === true,
    summary: data.summary || data.description,
    body,
    html: render(body),
    faq: faqOf(tokens),
    words,
    minutes: Math.max(1, Math.round(words / 220)),
    url: `/journal/${m[2]}/`,
  };
}

// Every published post, newest first (drafts left out unless asked for).
export function allPosts({ drafts = false } = {}) {
  let files = [];
  try {
    files = readdirSync(POSTS).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return files
    .map(readPost)
    .filter((p) => drafts || !p.draft)
    .sort((a, b) => (a.date === b.date ? b.file.localeCompare(a.file) : b.date.localeCompare(a.date)));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const parts = (iso) => iso.split('-').map(Number);
export const longDate = (iso) => {
  const [y, mo, d] = parts(iso);
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
};
export const shortDate = (iso) => {
  const [, mo, d] = parts(iso);
  return `${MONTHS[mo - 1].slice(0, 3)} ${d}`;
};
export const monthOf = (iso) => {
  const [y, mo] = parts(iso);
  return `${MONTHS[mo - 1]} ${y}`;
};
export const rfc822 = (iso) => new Date(`${iso}T15:00:00Z`).toUTCString();
