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
const INITIAL_WAIT_SECONDS = 2;
const RECOVERY_WAIT_MS = 10_000;
const MAX_LIMIT = 50;

function escapeForTemplate(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function isReutersHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'reuters.com' || normalized.endsWith('.reuters.com');
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
    let parsed;

    if (!sectionUrl) {
      throw new Error('url is required');
    }

    try {
      parsed = new URL(sectionUrl);
    } catch {
      throw new Error('Invalid URL: ' + sectionUrl);
    }

    if (!isReutersHostname(parsed.hostname)) {
      throw new Error('Only reuters.com URLs are supported');
    }

    await page.goto(REUTERS_HOME);
    await page.wait(INITIAL_WAIT_SECONDS);

    const payload = await page.evaluate(`(async () => {
      const sectionUrl = \`${escapeForTemplate(sectionUrl)}\`.trim();
      const count = ${count};
      const recoveryWaitMs = ${RECOVERY_WAIT_MS};
      const parsed = new URL(sectionUrl);

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

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isReutersHostname = (hostname) => {
        const normalized = String(hostname || '').toLowerCase();
        return normalized === 'reuters.com' || normalized.endsWith('.reuters.com');
      };
      const isInterstitialHostname = (hostname) => {
        const normalized = String(hostname || '').toLowerCase();
        return normalized === 'geo.captcha-delivery.com' || normalized.endsWith('.geo.captcha-delivery.com');
      };

      const getPageState = () => {
        const href = String(location.href || '');
        const hostname = String(location.hostname || '');
        const title = String(document.title || '');
        const isInterstitialHost = isInterstitialHostname(hostname);
        const isInterstitialUrl = /interstitial/i.test(href);
        const isDataDomeTitle = /datadome|device check/i.test(title);
        const isReutersHost = isReutersHostname(hostname);
        const isReutersTitle = /reuters/i.test(title);

        return {
          href,
          hostname,
          title,
          isReutersReady: isReutersHost && isReutersTitle && !isDataDomeTitle,
          isInterstitial: isInterstitialHost || isInterstitialUrl || isDataDomeTitle,
        };
      };

      const formatItems = (items) => {
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
      };

      const fetchArticles = async () => {
        const pageState = getPageState();

        try {
          const resp = await fetch(apiUrl, { credentials: 'include' });
          if (!resp.ok) {
            return {
              ok: false,
              retryable: resp.status === 401 || pageState.isInterstitial,
              error: 'HTTP ' + resp.status + ' for alias ' + collectionAlias,
              status: resp.status,
              alias: collectionAlias,
              pageState,
            };
          }

          const data = await resp.json();
          const root = data?.result || data?.data?.data || data?.data || data;
          const items = root?.articles || root?.content_elements || root?.list;

          if (!Array.isArray(items)) {
            return {
              ok: false,
              retryable: false,
              error: 'Unexpected Reuters response structure for alias ' + collectionAlias,
              alias: collectionAlias,
              pageState,
            };
          }

          const formattedItems = formatItems(items);
          if (formattedItems.length === 0) {
            return {
              ok: false,
              retryable: true,
              error: 'Empty result for alias ' + collectionAlias,
              alias: collectionAlias,
              pageState,
            };
          }

          return {
            ok: true,
            items: formattedItems,
            pageState,
          };
        } catch (error) {
          return {
            ok: false,
            retryable: false,
            error: String(error),
            alias: collectionAlias,
            pageState,
          };
        }
      };

      const waitForReutersRecovery = async () => {
        const deadline = Date.now() + recoveryWaitMs;

        while (Date.now() < deadline) {
          const pageState = getPageState();
          if (!pageState.isInterstitial && pageState.isReutersReady) {
            return pageState;
          }

          await sleep(500);
        }

        return getPageState();
      };

      try {
        const firstAttempt = await fetchArticles();
        if (firstAttempt.ok) {
          return firstAttempt.items;
        }

        if (!firstAttempt.retryable) {
          return firstAttempt;
        }

        await waitForReutersRecovery();
        const secondAttempt = await fetchArticles();
        if (secondAttempt.ok) {
          return secondAttempt.items;
        }

        return {
          ...secondAttempt,
          retryAttempted: true,
          initialError: firstAttempt.error,
          initialStatus: firstAttempt.status,
          initialPageState: firstAttempt.pageState,
          finalPageState: secondAttempt.pageState,
        };
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
