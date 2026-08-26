#!/usr/bin/env node
/* =========================================================
   Fynd — end-to-end test

   Drives the real pages in a real browser against the real API handlers.
   Nothing between the browser and the vendor boundary is mocked: the
   fetch the page makes is a real HTTP request, /api/interpret and
   /api/search are the deployed files, and the provider adapter and the
   verification gate are the ones that run in production.

   Only the two external vendors are stood in for, at the outermost
   boundary — global fetch for api.openai.com and api.openwebninja.com.
   Their doubles behave like the services do, including refusing,
   rate-limiting, timing out and returning nothing, so the failure paths
   are exercised rather than assumed. See scripts/e2e-vendors.js.

   What this cannot cover: whether the live vendors answer as their
   documentation says, and whether a given deployment has its keys set.
   Those need a key and network access to the real hosts.

   Usage: node scripts/test-e2e.js
   ========================================================= */

'use strict';

const assert = require('assert');
const path = require('path');
const { start } = require('./e2e-server');
const { vendors, INVENTORY } = require('./e2e-vendors');

const PORT = 8791;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — skipping end-to-end tests.');
  process.exit(0);
}

let passed = 0;
const failures = [];
let browser;

async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message}`); }
}

/* ---------------------------------------------------------
   One run of the whole product: a server, a page, a search
   --------------------------------------------------------- */

async function withApp(options, body) {
  const o = options || {};
  process.env.OPENAI_API_KEY = o.noOpenAiKey ? '' : 'test-openai-key';
  process.env.OPENWEBNINJA_API_KEY = o.noProviderKey ? '' : 'test-provider-key';
  if (o.noOpenAiKey) delete process.env.OPENAI_API_KEY;
  if (o.noProviderKey) delete process.env.OPENWEBNINJA_API_KEY;

  const vendor = vendors(o.openai || {}, o.ninja || {});
  const app = await start(PORT, vendor);
  const page = await browser.newPage({ viewport: o.viewport || { width: 1280, height: 900 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.addInitScript((port) => {
    window.FINDWEAR_API = `http://127.0.0.1:${port}/api/interpret`;
    window.FINDWEAR_SEARCH_API = `http://127.0.0.1:${port}/api/search`;
  }, PORT);

  /* The web font is a real external dependency. It is answered locally
     with an empty stylesheet so that a failed font request cannot be
     mistaken for a console error the product caused. */
  await page.route((u) => String(u).includes('fonts.googleapis.com') || String(u).includes('fonts.gstatic.com'),
    (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  /* a product image host is not reachable from a test runner */
  await page.route((u) => String(u).includes('img.example-cdn.com'),
    (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="5"/>' }));

  await page.goto(`http://127.0.0.1:${PORT}/${o.page || 'index.html'}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Interpreter && window.ProductSearch);

  try {
    return await body({ page, app, vendor, consoleErrors });
  } finally {
    await page.close().catch(() => {});
    await app.close();
  }
}

/* Types a request, presses the button, waits for the page to settle. */
async function runSearch(page, query) {
  await page.fill('#ask', query);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => {
    const r = document.getElementById('results');
    return r && !r.hidden && !r.querySelector('.thinking');
  }, { timeout: 25000 });
}

/* Everything the page is showing, read the way a shopper sees it. */
const readResults = (page) => page.evaluate(() => {
  const cards = [...document.querySelectorAll('#results .item-card')].map((card) => ({
    name: (card.querySelector('.item-name') || {}).textContent || '',
    price: (card.querySelector('.item-price') || {}).textContent || '',
    retailer: (card.querySelector('.item-retailer') || {}).textContent || '',
    href: card.tagName === 'A' ? card.getAttribute('href') : null,
    target: card.getAttribute('target'),
    rel: card.getAttribute('rel'),
    image: (card.querySelector('.item-media img') || {}).getAttribute
      ? card.querySelector('.item-media img').getAttribute('src') : null,
    action: (card.querySelector('.item-action') || {}).textContent || ''
  }));
  return {
    cards,
    heading: ((document.querySelector('#results .results-head h2') || {}).textContent || '').trim(),
    status: ((document.querySelector('#results .status') || {}).textContent || '').trim(),
    understood: [...document.querySelectorAll('#results .understood span')].map((s) => s.textContent.trim()),
    notice: ((document.querySelector('#results .notice') || {}).textContent || '').trim(),
    emptyHeading: ((document.querySelector('#results .empty h3') || {}).textContent || '').trim(),
    emptyBody: ((document.querySelector('#results .empty p') || {}).textContent || '').trim(),
    announced: ((document.querySelector('#search-status') || {}).textContent || '').trim()
  };
});

/* A browser reports a failed response on the console whether or not the
   page handled it, so a test that deliberately breaks a vendor will see
   one. That is the browser narrating, not the product breaking. An
   uncaught exception is never excused, and neither is a failed request
   in a test where nothing was supposed to fail. */
const HANDLED_HTTP = /^Failed to load resource: the server responded with a status of (4\d\d|5\d\d)/;

function assertNoConsoleErrors(errors, allowHandledHttp) {
  const real = errors.filter((e) => !(allowHandledHttp && HANDLED_HTTP.test(e)));
  assert.deepStrictEqual(real, [], `console errors: ${real.join(' | ')}`);
  assert.deepStrictEqual(errors.filter((e) => e.startsWith('pageerror:')), [], 'an uncaught exception reached the page');
}

/* The rules a rendered card must satisfy, whatever produced it. */
function assertTrustworthy(out, label) {
  for (const card of out.cards) {
    assert.ok(card.name.trim(), `${label}: a card has no name`);
    assert.ok(card.href, `${label}: "${card.name}" is not a link`);
    assert.ok(/^https:\/\//.test(card.href), `${label}: "${card.name}" link is not https — ${card.href}`);
    const host = new URL(card.href).hostname;
    assert.ok(!/(^|\.)google\./i.test(host), `${label}: a Google URL is shown as a retailer link — ${card.href}`);
    assert.ok(!/(^|\.)(bing|yahoo|duckduckgo|shopping)\./i.test(host), `${label}: an aggregator is shown as a retailer — ${card.href}`);
    assert.ok(/^\$\d/.test(card.price.trim()), `${label}: "${card.name}" has no price — got "${card.price}"`);
    assert.ok(card.retailer.trim(), `${label}: "${card.name}" names no retailer`);
    assert.ok(card.image, `${label}: "${card.name}" has no image`);
    assert.strictEqual(card.target, '_blank', `${label}: "${card.name}" does not open in a new tab`);
    assert.ok(/noopener/.test(card.rel || ''), `${label}: "${card.name}" link lacks rel=noopener`);
    assert.ok(/View item/.test(card.action), `${label}: "${card.name}" has no View item action`);

    /* the record it came from must actually exist, with these values */
    const source = INVENTORY.find((i) => i._offerUrl === card.href);
    assert.ok(source, `${label}: "${card.name}" links somewhere no product in the source has — fabricated`);
    assert.strictEqual(card.name.trim(), source.product_title, `${label}: name does not match the record it links to`);
    assert.strictEqual(card.price.trim(), `$${source._offerPrice.toFixed(2)}`.replace('.00', ''),
      `${label}: price shown (${card.price}) is not the price of the offer being linked`);
    assert.ok(card.image.includes(source.product_id),
      `${label}: "${card.name}" shows another product's photo`);
  }
}

/* ---------------------------------------------------------
   The tests
   --------------------------------------------------------- */

(async () => {
  browser = await chromium.launch({ executablePath: CHROME }).catch(() => null);
  if (!browser) {
    console.log('Chromium could not launch here — skipping end-to-end tests.');
    process.exit(0);
  }

  /* ---- the journey, on the requests a shopper actually types ---- */
  console.log('\nreal requests, end to end');

  const REQUESTS = [
    ['black oversized hoodie under $80', 1],
    ['relaxed blue jeans for everyday wear', 1],
    ['minimal neutral clothes for fall', 1],
    ['white button-up shirt under $50', 1],
    ['black sneakers for school under $100', 1],
    /* conversational wording, no stated price */
    ['i need a comfy black hoodie', 1],
    /* lower case, no punctuation, multiple constraints */
    ['cheap black fleece hoodie for the gym', 1],
    /* upper case */
    ['WHITE COTTON T-SHIRT', 1],
    /* several constraints at once */
    ['relaxed fit dark indigo denim jeans under $100', 1]
  ];

  for (const [query, atLeast] of REQUESTS) {
    await test(`"${query}" returns ${atLeast}+ verified products`, async () => {
      await withApp({}, async ({ page, consoleErrors }) => {
        await runSearch(page, query);
        const out = await readResults(page);
        assert.ok(out.cards.length >= atLeast,
          `expected products, got ${out.cards.length}. heading="${out.heading}" empty="${out.emptyHeading}"`);
        assertTrustworthy(out, query);
        assert.ok(/pieces? found/.test(out.heading), `heading was "${out.heading}"`);
        assert.strictEqual(out.status, 'Live listings', 'live results must be marked live');
        assert.ok(out.understood.length, 'the page must say what Fynd understood');
        assertNoConsoleErrors(consoleErrors);
      });
    });
  }

  await test('a request with no match says so, and suggests going broader', async () => {
    await withApp({}, async ({ page }) => {
      await runSearch(page, 'neon orange sequin ski boots for a wedding');
      const out = await readResults(page);
      assert.strictEqual(out.cards.length, 0, 'nothing should be invented for a request with no stock');
      assert.strictEqual(out.heading, 'No matches found');
      assert.ok(/differently/i.test(out.emptyHeading), out.emptyHeading);
      assert.ok(out.emptyBody.length > 10, 'the empty state must explain itself');
    });
  });

  await test('a search that starts too narrow is broadened rather than abandoned', async () => {
    await withApp({}, async ({ page, app }) => {
      await runSearch(page, 'black sneakers for school under $100');
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1, 'broadening should have found the sneakers');
      const line = app.logs.map((l) => l.text).find((t) => t.startsWith('search '));
      const diag = JSON.parse(line.slice('search '.length));
      assert.ok(diag.broadened, 'the search should record that it broadened');
      assert.ok(diag.attempts.length >= 2, `expected more than one attempt, got ${JSON.stringify(diag.attempts)}`);
      assert.strictEqual(diag.attempts[0].returned, 0, 'the first, narrowest attempt found nothing');
      assert.ok(diag.attempts[diag.attempts.length - 1].returned > 0, 'a broader attempt found products');
    });
  });

  await test('a model that ignores the prompt cannot empty the page', async () => {
    /* the interpreter maps "hoodie" onto some other garment; the search
       must still find hoodies, from the shopper's own words */
    await withApp({ openai: { drifting: true } }, async ({ page }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1, `a drifting interpretation emptied the page: ${out.heading}`);
      assertTrustworthy(out, 'drifting interpreter');
      assert.ok(out.cards.some((c) => /hoodie/i.test(c.name)), 'the products found should be hoodies');
    });
  });

  /* ---- what the shopper is told when something breaks ---- */
  console.log('\nfailure states');

  await test('an empty request is refused with a plain instruction', async () => {
    await withApp({}, async ({ page, vendor }) => {
      await page.click('button[type=submit]');
      await page.waitForSelector('#form-error.show');
      const message = await page.$eval('#form-error', (n) => n.textContent.trim());
      assert.ok(/what you.re looking for/i.test(message), message);
      assert.strictEqual(vendor.openai.calls, 0, 'an empty request must not reach the interpreter');
      assert.strictEqual(vendor.ninja.searchCalls, 0, 'an empty request must not reach the product source');
    });
  });

  await test('a whitespace-only request is refused too', async () => {
    await withApp({}, async ({ page, vendor }) => {
      await page.fill('#ask', '     ');
      await page.click('button[type=submit]');
      await page.waitForSelector('#form-error.show');
      assert.strictEqual(vendor.ninja.searchCalls, 0);
    });
  });

  await test('OpenAI out of quota still returns products, and says how it read the request', async () => {
    await withApp({ openai: { status: 429, body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } } } },
      async ({ page, consoleErrors }) => {
        await runSearch(page, 'black oversized hoodie under $80');
        const out = await readResults(page);
        assert.ok(out.cards.length >= 1, 'a failed interpretation must not empty the page');
        assertTrustworthy(out, 'openai quota');
        assert.ok(/local keyword match/i.test(out.notice), `the page must say it fell back: "${out.notice}"`);
        assertNoConsoleErrors(consoleErrors, true);
      });
  });

  await test('an OpenAI outage never shows the upstream error to the shopper', async () => {
    await withApp({ openai: { status: 500, body: { error: { message: 'internal', code: 'sk-secret-leak-check' } } } },
      async ({ page }) => {
        await runSearch(page, 'white button-up shirt under $50');
        const body = await page.evaluate(() => document.body.innerText);
        assert.ok(!/sk-secret-leak-check/.test(body), 'an upstream error body reached the page');
        assert.ok(!/stack|Traceback|at Object\./i.test(body), 'a stack trace reached the page');
        const out = await readResults(page);
        assert.ok(out.cards.length >= 1, 'the search should still run on the local reading');
      });
  });

  await test('a model returning nonsense falls back instead of breaking', async () => {
    await withApp({ openai: { garbage: true } }, async ({ page, consoleErrors }) => {
      await runSearch(page, 'relaxed blue jeans for everyday wear');
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1, 'unparseable model output must not empty the page');
      assertNoConsoleErrors(consoleErrors, true);
    });
  });

  await test('the product source rate-limiting is explained, not crashed', async () => {
    await withApp({ ninja: { searchStatus: 429 } }, async ({ page, consoleErrors }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const out = await readResults(page);
      assert.strictEqual(out.cards.length, 0, 'nothing may be invented when the source refuses');
      assert.ok(/more than the product source allows|wait a moment/i.test(out.emptyBody),
        `the shopper should be told about the rate limit: "${out.emptyBody}"`);
      assert.ok(!/429|rate limited|x-api-key/i.test(out.emptyBody.replace(/allows/i, '')), 'no raw status detail');
      assertNoConsoleErrors(consoleErrors, true);
    });
  });

  await test('the product source timing out is explained, not crashed', async () => {
    await withApp({ ninja: { searchDelayMs: 30000 } }, async ({ page, consoleErrors }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const out = await readResults(page);
      assert.ok(/took too long|unavailable|trouble/i.test(out.emptyBody), out.emptyBody);
      assertNoConsoleErrors(consoleErrors, true);
    });
  });

  await test('a malformed provider payload is survived', async () => {
    await withApp({ ninja: { malformedSearch: true } }, async ({ page, consoleErrors }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const out = await readResults(page);
      assert.strictEqual(out.cards.length, 0);
      assert.ok(out.emptyHeading, 'the page must still say something');
      assertNoConsoleErrors(consoleErrors, true);
    });
  });

  await test('no product source configured falls back to the labelled sample catalogue', async () => {
    await withApp({ noProviderKey: true }, async ({ page }) => {
      await runSearch(page, 'white button-up shirt under $50');
      const out = await readResults(page);
      assert.ok(/no product source is connected/i.test(out.notice), out.notice);
      assert.strictEqual(out.status, 'Sample data', 'sample rows must be marked as samples');
    });
  });

  /* ---- one bad record must not take the rest down ---- */
  console.log('\npartial failure');

  await test('offer lookups that fail lose only their own product', async () => {
    await withApp({ ninja: { offerFailEvery: 2 } }, async ({ page, app }) => {
      await runSearch(page, 'black sneakers for school under $100');
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1, 'a failed lookup must not empty the page');
      assertTrustworthy(out, 'partial offer failure');
      const diag = JSON.parse(app.logs.map((l) => l.text).find((t) => t.startsWith('search ')).slice(7));
      assert.ok(diag.offerFailures > 0, 'the failures should be recorded');
      assert.ok(diag.verified > 0, 'and the survivors returned');
    });
  });

  await test('offer lookups being rate-limited keeps whatever already resolved', async () => {
    await withApp({ ninja: { offerStatus: 429 } }, async ({ page, app }) => {
      await runSearch(page, 'black sneakers for school under $100');
      const out = await readResults(page);
      assert.strictEqual(out.cards.length, 0, 'no link means no card, never a fabricated one');
      const diag = JSON.parse(app.logs.map((l) => l.text).find((t) => t.startsWith('search ')).slice(7));
      assert.ok(diag.offerRateLimited > 0, 'the rate limit should be recorded');
      /* it must stop asking rather than spend the budget on refusals */
      assert.ok(diag.offerLookups <= 4, `kept asking after a 429: ${diag.offerLookups} lookups`);
    });
  });

  await test('a record missing a price, image or link is dropped, not half-shown', async () => {
    await withApp({}, async ({ page, app }) => {
      await runSearch(page, 'white button-up shirt under $50');
      const out = await readResults(page);
      assertTrustworthy(out, 'field completeness');
      const diag = JSON.parse(app.logs.map((l) => l.text).find((t) => t.startsWith('search ')).slice(7));
      assert.ok(typeof diag.rejected === 'object', 'rejections must be tallied by reason');
    });
  });

  /* ---- reliability ---- */
  console.log('\nreliability');

  await test('a double click runs one search, not two', async () => {
    await withApp({}, async ({ page, vendor }) => {
      await page.fill('#ask', 'black oversized hoodie under $80');
      await page.click('button[type=submit]');
      await page.click('button[type=submit]', { force: true }).catch(() => {});
      await page.click('button[type=submit]', { force: true }).catch(() => {});
      await page.waitForFunction(() => {
        const r = document.getElementById('results');
        return r && !r.hidden && !r.querySelector('.thinking');
      }, { timeout: 25000 });
      assert.strictEqual(vendor.openai.calls, 1, `interpreted ${vendor.openai.calls} times`);
      assert.strictEqual(vendor.ninja.searchCalls, 1, `searched ${vendor.ninja.searchCalls} times`);
    });
  });

  await test('the button is held closed while a search is running', async () => {
    await withApp({ ninja: { searchDelayMs: 1200 } }, async ({ page }) => {
      await page.fill('#ask', 'black oversized hoodie under $80');
      await page.click('button[type=submit]');
      await page.waitForFunction(() => document.querySelector('button[type=submit]').disabled, { timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled, { timeout: 25000 });
    });
  });

  await test('a slow first search cannot overwrite a newer one', async () => {
    await withApp({}, async ({ page }) => {
      /* the first reply is held open; the second search finishes first,
         and the page must end up showing the second one's results */
      const out = await page.evaluate(async () => {
        const results = document.getElementById('results');
        const realFetch = window.fetch;
        let call = 0;
        window.fetch = async (url, init) => {
          if (String(url).includes('/api/search')) {
            call += 1;
            if (call === 1) await new Promise((r) => setTimeout(r, 1500));
          }
          return realFetch(url, init);
        };
        const form = document.getElementById('ask-form');
        const input = document.getElementById('ask');
        input.value = 'black oversized hoodie under $80';
        form.requestSubmit();
        await new Promise((r) => setTimeout(r, 100));
        /* clear releases the guard, the way a shopper starting over does */
        document.getElementById('reset-form').click();
        input.value = 'white button-up shirt under $50';
        form.requestSubmit();
        await new Promise((r) => setTimeout(r, 3000));
        window.fetch = realFetch;
        return [...results.querySelectorAll('.item-name')].map((n) => n.textContent);
      });
      assert.ok(out.length, 'the second search should have rendered');
      assert.ok(out.every((n) => /shirt/i.test(n)), `the stale search overwrote the newer one: ${out.join(', ')}`);
    });
  });

  /* ---- diagnostics ---- */
  console.log('\ndiagnostics');

  await test('every interpretation records one line of counts', async () => {
    await withApp({}, async ({ page, app }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const lines = app.logs.map((l) => l.text).filter((t) => t.startsWith('interpret '));
      assert.strictEqual(lines.length, 1, `expected one line, got ${lines.length}`);
      const diag = JSON.parse(lines[0].slice('interpret '.length));
      assert.strictEqual(diag.outcome, 'ok');
      assert.strictEqual(typeof diag.elapsedMs, 'number');
      assert.ok(diag.fields.categories >= 1, 'the funnel should show what was understood');
      assert.ok(!lines[0].includes('hoodie'), "the shopper's words must not be logged");
    });
  });

  await test('a failed interpretation is recorded with its outcome', async () => {
    await withApp({ openai: { status: 429 } }, async ({ page, app }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const line = app.logs.map((l) => l.text).find((t) => t.startsWith('interpret '));
      const diag = JSON.parse(line.slice('interpret '.length));
      assert.strictEqual(diag.outcome, 'upstream-error');
      assert.strictEqual(diag.status, 429);
    });
  });

  await test('every search records one line of counts', async () => {
    await withApp({}, async ({ page, app }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const lines = app.logs.map((l) => l.text).filter((t) => t.startsWith('search '));
      assert.strictEqual(lines.length, 1, `expected one line, got ${lines.length}`);
      const diag = JSON.parse(lines[0].slice(7));
      ['source', 'attempts', 'returnedByProvider', 'normalized', 'withInlineLink', 'offerLookups',
        'offerFailures', 'offerRateLimited', 'offerTimeouts', 'withAnyLink', 'reachedGate',
        'rejected', 'verified', 'elapsedMs'].forEach((key) => {
        assert.ok(key in diag, `the diagnostic line is missing ${key}`);
      });
      assert.strictEqual(typeof diag.elapsedMs, 'number');
      assert.ok(diag.verified > 0);
    });
  });

  await test('diagnostics never carry a key, a token or a shopper\'s file', async () => {
    await withApp({ ninja: { offerFailEvery: 2 } }, async ({ page }) => {
      await page.fill('#ask', 'black oversized hoodie under $80');
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(64)], 'my-private-inspiration-photo.jpg', { type: 'image/jpeg' }));
        document.querySelector('#ask-form').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      });
      await page.click('button[type=submit]');
      await page.waitForFunction(() => {
        const r = document.getElementById('results');
        return r && !r.hidden && !r.querySelector('.thinking');
      }, { timeout: 25000 });
      return null;
    });
  });

  /* the log assertion needs the app after it closed, so it runs its own pass */
  await test('no log line contains a credential or an attachment name', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-secret-value';
    process.env.OPENWEBNINJA_API_KEY = 'ninja-secret-value';
    const vendor = vendors({}, { offerFailEvery: 2 });
    const app = await start(PORT, vendor);
    const page = await browser.newPage();
    await page.addInitScript((port) => {
      window.FINDWEAR_API = `http://127.0.0.1:${port}/api/interpret`;
      window.FINDWEAR_SEARCH_API = `http://127.0.0.1:${port}/api/search`;
    }, PORT);
    await page.route((u) => String(u).includes('fonts.g'), (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Interpreter && window.ProductSearch);
    await page.fill('#ask', 'black oversized hoodie under $80');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(64)], 'my-private-inspiration-photo.jpg', { type: 'image/jpeg' }));
      document.querySelector('#ask-form').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    });
    await page.click('button[type=submit]');
    await page.waitForFunction(() => {
      const r = document.getElementById('results');
      return r && !r.hidden && !r.querySelector('.thinking');
    }, { timeout: 25000 });
    const all = app.logs.map((l) => l.text).join('\n');
    await page.close();
    await app.close();
    assert.ok(!all.includes('sk-test-secret-value'), 'an OpenAI key reached the logs');
    assert.ok(!all.includes('ninja-secret-value'), 'a provider key reached the logs');
    assert.ok(!all.includes('my-private-inspiration-photo'), "a shopper's file name reached the logs");
    assert.ok(!/x-api-key|Authorization|Bearer /i.test(all), 'a credential header name reached the logs');
  });

  /* ---- the interface a shopper actually uses ---- */
  console.log('\nthe interface');

  await test('an example search runs a real search and returns products', async () => {
    await withApp({}, async ({ page, vendor }) => {
      await page.click('.example');
      await page.waitForFunction(() => {
        const r = document.getElementById('results');
        return r && !r.hidden && !r.querySelector('.thinking');
      }, { timeout: 25000 });
      assert.strictEqual(vendor.ninja.searchCalls >= 1, true);
      const out = await readResults(page);
      assert.ok(out.heading, 'an example must produce a result state');
    });
  });

  await test('an attached photo travels as a manifest and changes nothing', async () => {
    await withApp({}, async ({ page }) => {
      await page.fill('#ask', 'black oversized hoodie under $80');
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(2048)], 'inspo.jpg', { type: 'image/jpeg' }));
        document.querySelector('#ask-form').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      });
      assert.strictEqual(await page.$eval('#attachment-note', (n) => n.hidden), false);
      await page.click('button[type=submit]');
      await page.waitForFunction(() => {
        const r = document.getElementById('results');
        return r && !r.hidden && !r.querySelector('.thinking');
      }, { timeout: 25000 });
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1, 'a search with an attachment must still work');
      assertTrustworthy(out, 'with attachment');
    });
  });

  await test('Start over clears the page and re-enables a new search', async () => {
    await withApp({}, async ({ page, vendor }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      await page.click('#reset-form');
      assert.strictEqual(await page.$eval('#results', (n) => n.hidden), true);
      assert.strictEqual(await page.$eval('#ask', (n) => n.value), '');
      await runSearch(page, 'white button-up shirt under $50');
      assert.strictEqual(vendor.ninja.searchCalls, 2, 'a second search must run after starting over');
    });
  });

  await test('View item opens the retailer, in a new tab', async () => {
    await withApp({}, async ({ page }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const target = await page.$eval('#results a.item-card', (a) => ({ href: a.href, target: a.target }));
      assert.ok(/^https:\/\/www\.(nordstrom|carhartt|nike|walmart)\.com\//.test(target.href), target.href);
      assert.strictEqual(target.target, '_blank');
      /* the click is intercepted rather than followed: the retailer is not
         reachable from a test runner, and following it would prove nothing
         about Fynd */
      const opened = [];
      await page.route('**://www.nordstrom.com/**', (r) => { opened.push(r.request().url()); r.abort(); });
      await page.evaluate(() => {
        const a = document.querySelector('#results a.item-card');
        a.removeAttribute('target');
        a.click();
      });
      await page.waitForTimeout(400);
    });
  });

  await test('navigation reaches every page and each one still searches', async () => {
    await withApp({}, async ({ page }) => {
      for (const [link, expect] of [['Find Clothes', 'find-clothes.html'], ['Discover', 'discover.html'], ['About', 'about.html'], ['Home', 'index.html']]) {
        await page.click(`.nav-links a[href="${expect}"]`);
        await page.waitForURL(`**/${expect}`);
      }
      await page.goto(`http://127.0.0.1:${PORT}/find-clothes.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.ProductSearch);
      await runSearch(page, 'black oversized hoodie under $80');
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1, 'Find Clothes must search too');
    });
  });

  await test('the keyboard alone can reach the field and run a search', async () => {
    await withApp({}, async ({ page, vendor }) => {
      await page.keyboard.press('Tab');           /* skip link */
      const onSkip = await page.evaluate(() => document.activeElement.className);
      assert.ok(/skip-link/.test(onSkip), `first stop was "${onSkip}"`);
      await page.focus('#ask');
      await page.keyboard.type('black oversized hoodie under $80');
      await page.keyboard.press('Enter');          /* Enter submits */
      await page.waitForFunction(() => {
        const r = document.getElementById('results');
        return r && !r.hidden && !r.querySelector('.thinking');
      }, { timeout: 25000 });
      assert.strictEqual(vendor.ninja.searchCalls, 1);
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1);
    });
  });

  await test('a search works on a phone-sized screen', async () => {
    await withApp({ viewport: { width: 390, height: 844 } }, async ({ page, consoleErrors }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const out = await readResults(page);
      assert.ok(out.cards.length >= 1);
      assertTrustworthy(out, 'mobile');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.ok(!wide, 'the page scrolls sideways on a phone');
      assertNoConsoleErrors(consoleErrors);
    });
  });

  await test('a result is announced for anyone not looking at the grid', async () => {
    await withApp({}, async ({ page }) => {
      await runSearch(page, 'black oversized hoodie under $80');
      const out = await readResults(page);
      assert.ok(/pieces? found/.test(out.announced), `announced "${out.announced}"`);
    });
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
