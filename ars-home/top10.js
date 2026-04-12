import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadOpencliRegistry() {
  const entry = fs.realpathSync(process.argv[1]);
  const registryPath = path.resolve(path.dirname(entry), 'registry.js');
  return import(pathToFileURL(registryPath).href);
}

const { cli, Strategy } = await loadOpencliRegistry();

const FEED_URL = 'https://feeds.arstechnica.com/arstechnica/index';
const USER_AGENT = 'Mozilla/5.0 (compatible; opencli-custom)';

function stripCdata(text) {
  return String(text || '')
    .replace(/^<!\[CDATA\[/i, '')
    .replace(/\]\]>$/i, '');
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ');
}

function cleanText(text) {
  return stripTags(decodeXmlEntities(stripCdata(text))).replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? cleanText(m[1]) : '';
}

function toShanghai(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return fmt.format(d).replace(/\//g, '-');
}

function parseRss(xml, limit) {
  const results = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && results.length < limit) {
    const item = m[1];
    const title = extractTag(item, 'title');
    const url = extractTag(item, 'link') || extractTag(item, 'guid');
    const pubDate = extractTag(item, 'pubDate');
    if (!title || !url) continue;
    results.push({
      rank: results.length + 1,
      title,
      time: toShanghai(pubDate),
      url,
    });
  }
  return results;
}

cli({
  site: 'ArsPublic',
  name: 'news',
  description: 'Ars Technica top stories (title, time, url) with Asia/Shanghai time',
  domain: 'feeds.arstechnica.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'limit', type: 'int', default: 10, help: 'Number of items to return (max 30)' },
  ],
  columns: ['rank', 'title', 'time', 'url'],
  func: async (_page, kwargs) => {
    const count = Math.max(1, Math.min(Number(kwargs.limit) || 10, 30));
    const resp = await fetch(FEED_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) throw new Error(`Ars RSS HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseRss(xml, count);
  },
});
