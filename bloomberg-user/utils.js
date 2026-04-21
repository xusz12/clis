import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BLOOMBERG_USER_FEEDS = {
  main: 'https://feeds.bloomberg.com/news.rss',
  tech: 'https://feeds.bloomberg.com/technology/news.rss',
  politics: 'https://feeds.bloomberg.com/politics/news.rss',
  economics: 'https://feeds.bloomberg.com/economics/news.rss',
};

const USER_AGENT = 'Mozilla/5.0 (compatible; opencli-custom)';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

export async function loadOpencliRegistry() {
  const entry = fs.realpathSync(process.argv[1]);
  const registryPath = path.resolve(path.dirname(entry), 'registry.js');
  return import(pathToFileURL(registryPath).href);
}

function stripCdata(text) {
  return String(text || '')
    .replace(/^<!\[CDATA\[/i, '')
    .replace(/\]\]>$/i, '');
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&#8216;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8230;/g, '...')
    .replace(/&#038;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function parseRss(xml, limit) {
  const results = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && results.length < limit) {
    const item = m[1];
    const title = extractTag(item, 'title');
    const summary = extractTag(item, 'description');
    const url = extractTag(item, 'link') || extractTag(item, 'guid');
    const pubDate = extractTag(item, 'pubDate');
    if (!title || !url) continue;
    results.push({
      rank: results.length + 1,
      title,
      time: toShanghai(pubDate),
      url,
      summary,
    });
  }
  return results;
}

export async function fetchBloombergUserFeed(name, limit = DEFAULT_LIMIT) {
  const feedUrl = BLOOMBERG_USER_FEEDS[name];
  if (!feedUrl) {
    throw new Error(`Unknown BloombergUser feed: ${name}`);
  }

  const count = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const resp = await fetch(feedUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) throw new Error(`Bloomberg RSS HTTP ${resp.status}`);
  const xml = await resp.text();
  const items = parseRss(xml, count);
  if (!items.length) throw new Error('Bloomberg RSS feed returned no items');
  return items;
}

export function createBloombergUserCliConfig({ cli, Strategy, name, description }) {
  return {
    site: 'BloombergUser',
    name,
    description,
    domain: 'feeds.bloomberg.com',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `Number of feed items to return (max ${MAX_LIMIT})` },
    ],
    columns: ['rank', 'title', 'time', 'url', 'summary'],
    func: async (_page, kwargs) => {
      return fetchBloombergUserFeed(name, kwargs.limit ?? DEFAULT_LIMIT);
    },
  };
}
