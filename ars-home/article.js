import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const SITE = 'Ars Technica';
const DOMAIN_RE = /^https?:\/\/(?:www\.)?arstechnica\.com\//i;
const CHALLENGE_RE = /datadome|verify you are human|captcha|access to this page has been denied|unusual traffic|subscribe to continue|subscription required|sign in to continue|log in to continue/i;
const ARTICLE_READY_TIMEOUT_MS = 15000;
const ARTICLE_READY_POLL_SECONDS = 1;

function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/,\s*opens new tab\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeContentText(value) {
  return dedupeLines(
    String(value ?? '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter(Boolean),
  ).join('\n\n');
}

function dedupeLines(lines) {
  const output = [];
  for (const line of lines) {
    if (!line) continue;
    if (output[output.length - 1] === line) continue;
    output.push(line);
  }
  return output;
}

function mapDetail(article, bodyText, fallbackUrl = null) {
  if (!article && !bodyText) return null;
  const title = normalizeText(article?.title);
  const publishedAt = normalizeText(article?.published_at);
  const author = normalizeText(article?.author);
  const canonicalUrl = normalizeText(article?.canonical_url) || normalizeText(fallbackUrl);
  const body = normalizeContentText(bodyText);

  return {
    title: title || null,
    published_at: publishedAt || null,
    authors: author || null,
    url: canonicalUrl || null,
    content: body || null,
    content_length: body ? body.length : 0,
  };
}

function buildArticleDetailScript() {
  return `
    (() => {
      try {
        const normalize = (value) => String(value ?? '')
          .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
          .replace(/,\\s*opens new tab\\.?/gi, '')
          .replace(/\\s{2,}/g, ' ')
          .trim();

        const dedupeLines = (lines) => {
          const output = [];
          for (const line of lines) {
            if (!line) continue;
            if (output[output.length - 1] === line) continue;
            output.push(line);
          }
          return output;
        };

        const title =
          normalize(document.querySelector('main#main article h1')?.textContent) ||
          normalize(document.querySelector('article h1')?.textContent) ||
          normalize(document.querySelector('h1')?.textContent) ||
          normalize(document.querySelector('meta[property="og:title"]')?.content) ||
          normalize(document.title);

        const canonicalUrl =
          normalize(document.querySelector('link[rel="canonical"]')?.href) ||
          normalize(document.querySelector('meta[property="og:url"]')?.content);

        const publishedAt =
          normalize(document.querySelector('main#main article time[title]')?.getAttribute('title')) ||
          normalize(document.querySelector('article time[title]')?.getAttribute('title')) ||
          normalize(document.querySelector('article time[datetime]')?.getAttribute('datetime')) ||
          normalize(document.querySelector('meta[property="article:published_time"]')?.content) ||
          normalize(document.querySelector('meta[name="article:published_time"]')?.content) ||
          normalize(document.querySelector('article time')?.textContent);

        const authorNodes = Array.from(document.querySelectorAll(
          'article a[rel="author"], article [rel="author"], article [class*="byline"], article a[href*="/author/"]'
        ))
          .map((node) => normalize(node.textContent))
          .map((text) => text.replace(/^By\\s+/i, '').trim())
          .filter(Boolean);
        const authors = Array.from(new Set(authorNodes)).join(', ');

        const container =
          document.querySelector('main#main article') ||
          document.querySelector('article') ||
          document.querySelector('main#main');

        const contentSelector = [
          'main#main article .post-content p',
          'main#main article .post-content h2',
          'main#main article .post-content h3',
          'main#main article .post-content h4',
          'main#main article .post-content blockquote',
          'article .post-content p',
          'article .post-content h2',
          'article .post-content h3',
          'article .post-content h4',
          'article .post-content blockquote'
        ].join(', ');
        const blockNodes = Array.from(document.querySelectorAll(contentSelector));
        const noiseAncestorSelector = [
          '.ars-interlude-container',
          '.ad-wrapper',
          '.ad',
          '.advertisement',
          'aside',
          'figure',
          'figcaption',
          'nav',
          'header',
          'footer',
          '[class*="caption"]',
          '[class*="comment"]',
          '[class*="newsletter"]',
          '[class*="popular"]',
          '[class*="related"]',
          '[class*="share"]',
          '[class*="social"]',
          '[class*="teaser"]',
          '[class*="video"]'
        ].join(', ');

        const isNoise = (text) => {
          if (!text) return true;
          return /^(Advertisement|Ars Video\\b.*|Sign up here|Subscribe|Read this next|Related|Most Popular|Latest Stories|Comments|Reader comments|Image Credits?)$/i.test(text)
            || /cookie policy|privacy policy|terms of use/i.test(text)
            || /newsletter|most popular|related stories|reader comments/i.test(text)
            || /^follow us on/i.test(text);
        };

        const bodyLines = [];
        for (const node of blockNodes) {
          if (node.closest(noiseAncestorSelector)) continue;
          const text = normalize(node.textContent);
          if (isNoise(text)) continue;
          if (/^Our standards:/i.test(text) || /^Purchase Licensing Rights/i.test(text)) break;
          bodyLines.push(text);
        }

        const bodyText = dedupeLines(bodyLines).join('\\n\\n');
        const pageText = normalize(document.body?.innerText || '');
        const h1Text = normalize(document.querySelector('main#main article h1')?.textContent);
        const paragraphCount = document.querySelectorAll('main#main article .post-content p, article .post-content p').length;
        const challengeText = ${CHALLENGE_RE.toString()}.test([
          location.href || '',
          document.title || '',
          pageText.slice(0, 5000),
        ].join('\\n'));
        const authRequired = !title || bodyText.length < 200 ? challengeText : false;

        return {
          ok: true,
          authRequired,
          diagnostics: {
            url: location.href || '',
            title: document.title || '',
            h1Text,
            paragraphCount,
            bodyLength: bodyText.length,
            challengeText,
          },
          body: {
            article: {
              title: title || null,
              published_at: publishedAt || null,
              author: authors || null,
              canonical_url: canonicalUrl || null,
            },
            bodyText,
          },
        };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    })()
  `;
}

async function readArticlePayload(page) {
  let result;
  try {
    result = await page.evaluate(buildArticleDetailScript());
  } catch (error) {
    throw new CommandExecutionError(`ArsPublic article DOM evaluation failed: ${String(error?.message || error)}`);
  }

  if (result?.error) {
    throw new CommandExecutionError(`ArsPublic article failed inside the page: ${result.error}`);
  }
  if (!result || result.ok !== true) {
    throw new CommandExecutionError('ArsPublic article returned no payload');
  }
  return result;
}

async function waitForArticlePayload(page, url) {
  const maxAttempts = Math.ceil(ARTICLE_READY_TIMEOUT_MS / (ARTICLE_READY_POLL_SECONDS * 1000)) + 1;
  let lastResult = null;
  let lastDetail = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await readArticlePayload(page);
    const detail = mapDetail(result.body?.article, result.body?.bodyText, url);
    lastResult = result;
    lastDetail = detail;

    if (detail?.title && detail?.content && detail.content_length >= 200) {
      return { result, detail };
    }

    if (attempt === maxAttempts - 1) break;
    await page.wait(ARTICLE_READY_POLL_SECONDS);
  }

  if (lastResult?.authRequired || lastResult?.diagnostics?.challengeText) {
    throw new AuthRequiredError('arstechnica.com', 'Ars Technica page is still blocked by browser verification');
  }
  if (!lastDetail || !lastDetail.title || !lastDetail.content) {
    throw new EmptyResultError('ArsPublic article', 'Page rendered no article body');
  }
  throw new EmptyResultError('ArsPublic article', `Extracted content length ${lastDetail.content_length} < 200`);
}

cli({
  site: 'ArsPublic',
  name: 'article',
  description: 'Ars Technica article detail by URL (title, author, published_at, content)',
  access: 'read',
  domain: 'arstechnica.com',
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: 'url', positional: true, required: true, help: 'Ars Technica article URL' },
  ],
  columns: ['source', 'title', 'url', 'published_at', 'author', 'content', 'content_length', 'status'],
  func: async (page, kwargs) => {
    const url = String(kwargs.url || '').trim();
    if (!url) throw new ArgumentError('URL cannot be empty');
    if (!DOMAIN_RE.test(url)) throw new ArgumentError('Only arstechnica.com article URL is supported');

    await page.goto(url);
    const { detail } = await waitForArticlePayload(page, url);

    return [{
      source: SITE,
      title: detail.title,
      url: detail.url,
      published_at: detail.published_at,
      author: detail.authors,
      content: detail.content,
      content_length: detail.content_length,
      status: 'success',
    }];
  },
});

export { buildArticleDetailScript, mapDetail, waitForArticlePayload };
