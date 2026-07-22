import assert from 'node:assert/strict';
import test from 'node:test';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import './article.js';
import { buildArticleDetailScript, mapDetail, waitForArticlePayload } from './article.js';

function makePage(evaluateResult) {
  let index = 0;
  return {
    goto: async () => {},
    wait: async () => {},
    evaluate: async () => {
      if (Array.isArray(evaluateResult)) {
        const value = evaluateResult[Math.min(index, evaluateResult.length - 1)];
        index += 1;
        return value;
      }
      if (typeof evaluateResult === 'function') {
        const value = evaluateResult(index);
        index += 1;
        return value;
      }
      return evaluateResult;
    },
  };
}

test('ArsPublic article helpers', async (t) => {
  await t.test('maps article payload to final detail shape', () => {
    assert.deepEqual(
      mapDetail(
        {
          title: 'Headline',
          published_at: '2026-07-22T10:00:00Z',
          author: 'Jane Doe',
          canonical_url: 'https://arstechnica.com/science/x/',
        },
        'Body paragraph',
        'https://arstechnica.com/science/x/',
      ),
      {
        title: 'Headline',
        published_at: '2026-07-22T10:00:00Z',
        authors: 'Jane Doe',
        url: 'https://arstechnica.com/science/x/',
        content: 'Body paragraph',
        content_length: 'Body paragraph'.length,
      },
    );
  });

  await t.test('exports a browser script that targets visible article DOM', () => {
    const script = buildArticleDetailScript();
    assert.match(script, /main#main article/);
    assert.match(script, /time\[title\]/);
    assert.match(script, /a\[href\*="\/author\/"\]/);
    assert.match(script, /\.ars-interlude-container/);
    assert.match(script, /node\.closest\(noiseAncestorSelector\)/);
    assert.match(script, /verify you are human/);
  });

  await t.test('polls until article DOM has a usable body', async () => {
    let waits = 0;
    const page = {
      wait: async () => { waits += 1; },
      evaluate: makePage([
        { ok: true, authRequired: false, body: { article: { title: 'Headline' }, bodyText: '' } },
        { ok: true, authRequired: false, body: { article: { title: 'Headline' }, bodyText: 'short body' } },
        {
          ok: true,
          authRequired: false,
          body: {
            article: {
              title: 'Headline',
              published_at: '2026-07-22T10:00:00Z',
              author: 'Jane Doe',
              canonical_url: 'https://arstechnica.com/science/x/',
            },
            bodyText: 'Paragraph with enough content to satisfy the length requirement. '.repeat(5),
          },
        },
      ]).evaluate,
    };

    const { detail } = await waitForArticlePayload(page, 'https://arstechnica.com/science/x/');
    assert.equal(waits, 2);
    assert.equal(detail.title, 'Headline');
    assert.ok(detail.content_length > 200);
  });
});

test('ArsPublic article command (registry-level)', async (t) => {
  const cmd = getRegistry().get('ArsPublic/article');

  await t.test('declares browser-backed visible-UI strategy', () => {
    assert.equal(cmd.access, 'read');
    assert.match(String(cmd.strategy), /ui/i);
    assert.equal(cmd.browser, true);
  });

  await t.test('rejects empty and non-Ars URLs before navigation', async () => {
    const page = makePage(null);
    await assert.rejects(() => cmd.func(page, { url: '   ' }), ArgumentError);
    await assert.rejects(() => cmd.func(page, { url: 'https://example.com/a' }), ArgumentError);
  });

  await t.test('throws CommandExecutionError when page evaluate errors', async () => {
    const page = makePage({ error: 'boom' });
    await assert.rejects(() => cmd.func(page, { url: 'https://arstechnica.com/science/x/' }), CommandExecutionError);
  });

  await t.test('throws AuthRequiredError when the browser still sees a challenge', async () => {
    const page = makePage({
      ok: true,
      authRequired: true,
      body: { article: { title: 'Blocked' }, bodyText: 'short' },
    });
    await assert.rejects(() => cmd.func(page, { url: 'https://arstechnica.com/science/x/' }), AuthRequiredError);
  });

  await t.test('throws EmptyResultError when no usable article body is rendered', async () => {
    const page = makePage({
      ok: true,
      authRequired: false,
      body: { article: { title: 'Headline' }, bodyText: 'tiny body' },
    });
    await assert.rejects(() => cmd.func(page, { url: 'https://arstechnica.com/science/x/' }), EmptyResultError);
  });

  await t.test('returns a success row on normal article DOM', async () => {
    const page = makePage({
      ok: true,
      authRequired: false,
      body: {
        article: {
          title: 'Headline',
          published_at: '2026-07-22T10:00:00Z',
          author: 'Jane Doe',
          canonical_url: 'https://arstechnica.com/science/x/',
        },
        bodyText: 'Section title\n\nParagraph one.\n\nParagraph two with enough content to satisfy the length requirement. '.repeat(4),
      },
    });
    const rows = await cmd.func(page, { url: 'https://arstechnica.com/science/x/' });
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /Section title\n\nParagraph one/);
    assert.equal(rows[0].source, 'Ars Technica');
    assert.equal(rows[0].title, 'Headline');
    assert.equal(rows[0].url, 'https://arstechnica.com/science/x/');
    assert.equal(rows[0].published_at, '2026-07-22T10:00:00Z');
    assert.equal(rows[0].author, 'Jane Doe');
    assert.equal(rows[0].status, 'success');
    assert.ok(rows[0].content_length > 200);
  });
});
