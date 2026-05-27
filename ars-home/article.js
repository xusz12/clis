import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadOpencliRegistry() {
  const entry = fs.realpathSync(process.argv[1]);
  const registryPath = path.resolve(path.dirname(entry), 'registry.js');
  return import(pathToFileURL(registryPath).href);
}

const { cli, Strategy } = await loadOpencliRegistry();

const USER_AGENT = 'Mozilla/5.0 (compatible; opencli-custom)';
const SITE = 'Ars Technica';
const DOMAIN_RE = /^https?:\/\/(?:www\.)?arstechnica\.com\//i;

function failure(url, errorCode, reason) {
  return {
    source: SITE,
    title: '',
    url,
    published_at: '',
    author: '',
    content: '',
    content_length: 0,
    status: 'failed',
    error_code: errorCode,
    reason,
  };
}

function decodeHtml(text) {
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
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const m = html.match(re);
  return m ? decodeHtml(m[1]).trim() : '';
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) {
    return decodeHtml(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  }
  return extractMeta(html, 'og:title');
}

function extractAuthor(html) {
  const m = html.match(/<a[^>]*rel=["']author["'][^>]*>([\s\S]*?)<\/a>/i)
    || html.match(/<span[^>]*class=["'][^"']*byline[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (m) {
    return decodeHtml(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  }
  return extractMeta(html, 'author');
}

function extractByBalancedTag(html, tag, classNeedle) {
  const openRe = new RegExp(`<${tag}[^>]*class=["'][^"']*${classNeedle}[^"']*["'][^>]*>`, 'i');
  const openMatch = openRe.exec(html);
  if (!openMatch) return '';

  const start = openMatch.index;
  const tagRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = start;

  let depth = 0;
  let begin = -1;
  let end = -1;
  let m;
  while ((m = tagRe.exec(html))) {
    const isClose = m[0][1] === '/';
    if (!isClose) {
      if (depth === 0 && begin === -1) begin = m.index;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        end = tagRe.lastIndex;
        break;
      }
    }
  }
  if (begin === -1 || end === -1) return '';
  return html.slice(begin, end);
}

function toLinesFromHtml(block) {
  let cleaned = String(block || '');
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, '');
  cleaned = cleaned.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  cleaned = cleaned.replace(/<div[^>]*class=["'][^"']*(?:video|ad|newsletter|related|comments|social|text-settings)[^"']*["'][\s\S]*?<\/div>/gi, '');
  cleaned = cleaned.replace(/<aside[^>]*class=["'][^"']*(?:sidebar|author|newsletter|related|video)[^"']*["'][\s\S]*?<\/aside>/gi, '');
  cleaned = cleaned.replace(/<figure[\s\S]*?<\/figure>/gi, '');
  cleaned = cleaned.replace(/<\/p>/gi, '\n');
  cleaned = cleaned.replace(/<\/(?:h2|h3|h4|blockquote|li|ul|ol)>/gi, '\n');
  cleaned = cleaned.replace(/<br\s*\/?\s*>/gi, '\n');
  cleaned = decodeHtml(cleaned.replace(/<[^>]+>/g, ' '));

  return cleaned
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !/^(Text settings|Comments|Subscribe|Read this next)$/i.test(line))
    .filter((line) => !/^(Ars Video|Most Popular|Latest Stories)$/i.test(line))
    .filter((line) => !/^(Reader comments|Image Credits?)$/i.test(line))
    .filter((line) => !/Terms of Use|Privacy Policy|Cookie Policy/i.test(line));
}

function normalizeContent(lines) {
  const output = [];
  for (const line of lines) {
    if (!line) continue;
    if (output[output.length - 1] === line) continue;
    output.push(line);
  }
  return output.join('\n\n').trim();
}

cli({
  site: 'ArsPublic',
  name: 'article',
  description: 'Ars Technica article detail by URL (title, author, published_at, content)',
  access: 'read',
  domain: 'arstechnica.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'url', positional: true, required: true, help: 'Ars Technica article URL' },
  ],
  columns: ['source', 'title', 'url', 'published_at', 'author', 'content', 'content_length', 'status'],
  func: async (kwargs) => {
    const url = String(kwargs.url || '').trim();
    if (!url) return [failure('', 'MALFORMED_URL', 'URL cannot be empty')];
    if (!DOMAIN_RE.test(url)) return [failure(url, 'UNSUPPORTED_URL', 'Only arstechnica.com article URL is supported')];

    let resp;
    try {
      resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      return [failure(url, 'NETWORK_ERROR', String(err?.message || err))];
    }

    const wafAction = String(resp.headers.get('x-amzn-waf-action') || '').toLowerCase();
    if (resp.status === 202 || wafAction === 'challenge') {
      return [failure(url, 'AUTH_REQUIRED', 'Ars Technica returned WAF challenge; authenticated browser/session is required')];
    }
    if (resp.status === 404) return [failure(url, 'NOT_FOUND', 'Article page returned 404')];
    if (!resp.ok) return [failure(url, 'HTTP_ERROR', `HTTP ${resp.status}`)];

    const html = await resp.text();
    const block = extractByBalancedTag(html, 'div', 'post-content');
    if (!block) return [failure(url, 'CONTENT_UNAVAILABLE', 'Article content container not found')];

    const content = normalizeContent(toLinesFromHtml(block));
    const contentLength = content.length;
    if (contentLength < 200) {
      return [failure(url, 'CONTENT_TOO_SHORT', `Extracted content length ${contentLength} < 200`)];
    }

    return [{
      source: SITE,
      title: extractTitle(html),
      url,
      published_at: extractMeta(html, 'article:published_time'),
      author: extractAuthor(html),
      content,
      content_length: contentLength,
      status: 'success',
    }];
  },
});
