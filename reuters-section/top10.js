import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadOpencliRegistry() {
  const entry = fs.realpathSync(process.argv[1]);
  const registryPath = path.resolve(path.dirname(entry), 'registry.js');
  return import(pathToFileURL(registryPath).href);
}

const { cli, Strategy } = await loadOpencliRegistry();

const REUTERS_HOME = 'https://www.reuters.com';
const MAX_LIMIT = 50;

function escapeForTemplate(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

cli({
  site: 'ReutersBrowser',
  name: 'news',
  description: 'Reuters section top stories with Asia/Shanghai local time',
  domain: 'www.reuters.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'url', type: 'str', required: true, positional: true, help: 'Reuters section URL' },
    { name: 'limit', type: 'int', default: 10, help: 'Number of items to return (max 50)' },
  ],
  columns: ['rank', 'title', 'time', 'url'],
  func: async (page, kwargs) => {
    const sectionUrl = String(kwargs.url || '').trim();
    const count = Math.max(1, Math.min(Number(kwargs.limit) || 10, MAX_LIMIT));

    await page.goto(REUTERS_HOME);
    await page.wait(2);

    const payload = await page.evaluate(`(async () => {
      const sectionUrl = \`${escapeForTemplate(sectionUrl)}\`.trim();
      const count = ${count};

      if (!sectionUrl) {
        return { error: 'url is required' };
      }

      let parsed;
      try {
        parsed = new URL(sectionUrl);
      } catch {
        return { error: 'Invalid URL: ' + sectionUrl };
      }

      if (!/reuters\\.com$/.test(parsed.hostname)) {
        return { error: 'Only reuters.com URLs are supported' };
      }

      const cleanPath = parsed.pathname.replace(/^\\/+|\\/+$/g, '');
      const collectionAlias = cleanPath ? cleanPath.replace(/\\//g, '-') : 'world';

      const apiQuery = JSON.stringify({
        collection_alias: collectionAlias,
        exclude: '',
        size: count,
        website: 'reuters',
      });

      const apiUrl =
        'https://www.reuters.com/pf/api/v3/content/fetch/articles-by-collection-alias-or-id-v1?query=' +
        encodeURIComponent(apiQuery);

      try {
        const resp = await fetch(apiUrl, { credentials: 'include' });
        if (!resp.ok) {
          return {
            error: 'HTTP ' + resp.status + ' for alias ' + collectionAlias,
            status: resp.status,
            alias: collectionAlias,
          };
        }

        const data = await resp.json();
        const root = data?.result || data?.data?.data || data?.data || data;
        const items = root?.articles || root?.content_elements || root?.list || [];

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

        const toShanghai = (raw) => {
          if (!raw) return '';
          const d = new Date(raw);
          if (Number.isNaN(d.getTime())) return String(raw);
          return fmt.format(d).replace(/\\//g, '-');
        };

        return items
          .slice(0, count)
          .map((article, index) => {
            const rawUrl = article.canonical_url || article.url || '';
            const absUrl = rawUrl.startsWith('http')
              ? rawUrl
              : rawUrl
                ? 'https://www.reuters.com' + rawUrl
                : '';

            return {
              rank: index + 1,
              title: article.title || article.headlines?.basic || article.basic_headline || '',
              time: toShanghai(
                article.display_date ||
                  article.published_time ||
                  article.first_publish_date ||
                  article.updated_date ||
                  '',
              ),
              url: absUrl,
            };
          })
          .filter((item) => item.title && item.url);
      } catch (error) {
        return { error: String(error), alias: collectionAlias };
      }
    })()`);

    if (!Array.isArray(payload)) {
      throw new Error(payload?.error || 'Reuters section fetch failed');
    }

    return payload;
  },
});
