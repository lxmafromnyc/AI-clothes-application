/* Walkthrough: the same shopper tasks on the old page (main) and the redesign,
   step by step, against Fynd's real API handlers. Every input the shopper makes
   (typed, chosen, ticked) is counted, and every button press, separately.
   usage: node scripts/find-fit-walkthrough.js after <outdir>
          REPO=<a checkout of main> node scripts/find-fit-walkthrough.js before <outdir>
   (screenshots in docs/find-fit-redesign/ were made this way) */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const LABEL = process.argv[2];
const OUT = path.join(process.argv[3], LABEL);
fs.mkdirSync(OUT, { recursive: true });
const REPO = process.env.REPO || path.join(__dirname, '..');
const serve = require('./find-fit-demo-server.js');

const ZARA = 'https://www.zara.com/us/en/basic-heavyweight-hoodie-p00761810.html';
/* Zara's own published figures for size M (Fynd's record of its page), as a shopper would copy them */
const ZARA_M = { chestWidth: '63.5', shoulderWidth: '54', bodyLength: '71', sleeveLength: '65' };
const ZARA_METHODS = { chestWidth: 'flat-width-armpit-to-armpit', shoulderWidth: 'seam-to-seam', bodyLength: 'high-point-shoulder-to-hem', sleeveLength: 'shoulder-seam-to-cuff' };
/* the shopper's own hoodie, measured at home (laid flat, in cm) */
const MINE = { chestWidth: '63', shoulderWidth: '54', bodyLength: '70.5', sleeveLength: '65' };

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const log = { label: LABEL, flows: {} };
  const after = LABEL === 'after';

  async function flow(name, setup, steps) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setup(ctx);
    const rec = { inputs: [], clicks: [], shots: [] };
    let n = 0;
    const shot = async (what) => { n += 1; await page.evaluate(() => window.scrollTo(0, 0)); const f = `${name}-${String(n).padStart(2, '0')}-${what}.png`; await page.screenshot({ path: path.join(OUT, f), fullPage: true }); rec.shots.push(f); };
    const act = {
      fill: async (sel, v, label) => { await page.fill(sel, v); rec.inputs.push(label || sel); },
      select: async (sel, v, label) => { await page.selectOption(sel, v); rec.inputs.push(label || sel); },
      check: async (sel, label) => { await page.check(sel); rec.inputs.push(label || sel); },
      click: async (sel, label) => { await page.click(sel); rec.clicks.push(label || sel); }
    };
    const t0 = Date.now();
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#ff-reference:not(:empty)');
    await page.waitForTimeout(400);
    await shot('open');
    await steps(page, act, shot);
    await page.waitForFunction(() => document.getElementById('fit-result').dataset.state === 'done', null, { timeout: 20000 });
    await page.waitForTimeout(300);
    rec.verdict = await page.getAttribute('#fit-compare', 'data-verdict');
    rec.recommended = await page.$eval('#fit-compare', (n) => { const r = n.querySelector('.fit-compare-recommended'); return r ? r.textContent.trim() : null; });
    rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (after) rec.countedByPage = await page.evaluate(() => (window.FyndMetrics && window.FyndMetrics.last ? window.FyndMetrics.last() : null));
    await shot('result');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('result-phone');
    rec.errors = errors;
    log.flows[name] = rec;
    await ctx.close();
  }

  /* a returning customer: a hoodie saved on their fit profile; considering Zara's Basic Heavyweight Hoodie */
  const saveHoodie = async (ctx, email) => {
    const r = await ctx.request.post(`${base}/api/auth`, { data: { action: 'signup', name: 'Shopper', email, password: 'correct-horse-battery-staple', confirmPassword: 'correct-horse-battery-staple' } });
    if (r.status() !== 200) throw new Error(`signup ${r.status()}`);
    const users = require(path.join(REPO, 'api/_users'));
    const fp = require(path.join(REPO, 'api/_fit-profile'));
    const S = require(path.join(REPO, 'assets/fit-profile-schema.js'));
    const p = S.empty();
    p.garments = { hoodies: Object.assign(S.emptyGarment('hoodies'), { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'L', measurements: Object.assign({ unit: 'cm' }, Object.fromEntries(Object.entries(MINE).map(([k, v]) => [k, Number(v)]))), methods: Object.assign({ registry: 1 }, ZARA_METHODS) } }) };
    await fp.save((await users.byEmail(email)).id, p);
  };

  /* the item by hand, as the old page asks: one size, four values, four methods */
  const itemByHand = async (page, act) => {
    await act.fill('#ffc-size', 'M', 'item size');
    for (const [k, v] of Object.entries(ZARA_M)) await act.fill(`#ffc-m-${k}`, v, `item ${k}`);
    for (const [k, m] of Object.entries(ZARA_METHODS)) await act.select(`#ffc-how-${k}`, m, `item ${k} method`);
  };

  await flow('returning', (ctx) => saveHoodie(ctx, `returning-${LABEL}@demo.test`), async (page, act, shot) => {
    await page.waitForSelector('#ff-reference[data-state="saved"]');
    if (!after) {
      await itemByHand(page, act);
      await shot('item-typed');
      await act.click('#ff-submit', 'Compare fit');
    } else {
      await act.fill('#ffi-link', ZARA, 'item link');
      await act.click('#ffi-link-go', 'Find it');
      await page.waitForSelector('#ffi-found[data-state="assisted"]');
      await shot('product-found');
      await act.check('#ffi-confirm', 'tick: these match the chart');
    }
  });

  await flow('first-time', async () => {}, async (page, act, shot) => {
    if (!after) {
      await act.fill('#ffr-brand', 'UNIQLO', 'garment brand');
      await act.select('#ffr-size', 'L', 'garment size');
      for (const [k, v] of Object.entries(MINE)) await act.fill(`#ffr-m-${k}`, v, `garment ${k}`);
      await act.click('#ffr-use', 'Use this garment');
      await shot('garment-kept');
      await itemByHand(page, act);
      await shot('item-typed');
      await act.click('#ff-submit', 'Compare fit');
    } else {
      await act.click('#ffr-manual > summary', 'Or enter its measurements');
      for (const [k, v] of Object.entries(MINE)) await act.fill(`#ffr-m-${k}`, v, `garment ${k}`);
      await shot('garment-measured');
      await act.fill('#ffi-link', ZARA, 'item link');
      await act.click('#ffi-link-go', 'Find it');
      await page.waitForSelector('#ffi-found[data-state="assisted"]');
      await shot('product-found');
      await act.check('#ffi-confirm', 'tick: these match the chart');
    }
  });

  /* the page at first sight, desktop and phone */
  for (const [name, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#ff-reference:not(:empty)');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `start-${name}.png`), fullPage: true });
    const vis = [];
    for (const h2 of await page.$$('#ff-form input:not([type=hidden]), #ff-form select')) if (await h2.isVisible()) vis.push(await h2.getAttribute('id') || await h2.getAttribute('name'));
    log[`visibleAtStart_${name}`] = vis;
    await page.close();
  }
  fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
  for (const [k, r] of Object.entries(log.flows)) console.log(`${LABEL} ${k}: ${r.inputs.length} inputs [${r.inputs.join(', ')}], ${r.clicks.length} clicks [${r.clicks.join(', ')}] → ${r.verdict} ${r.recommended || ''}${r.countedByPage ? ` | page counted ${r.countedByPage.manualInputs}` : ''}${r.errors.length ? ` ERRORS ${r.errors}` : ''}`);
  console.log(`${LABEL} visible at start: desktop ${log.visibleAtStart_desktop.length}, phone ${log.visibleAtStart_phone.length}`);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
