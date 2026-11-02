/* Which product links Find Fit handles automatically, which need the shopper's
   tick, and which need the extension or hand entry — pasted into the real page.
   For every link where measurements are shown, each value is checked against
   the brand's figures in Fynd's record. */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const REPO = path.join(__dirname, '..');
const serve = require('./find-fit-demo-server.js');
const R = require(path.join(REPO, 'api/_sizing/records'));
const { asChecked, UQ_PAIR } = require(path.join(REPO, 'scripts/fixtures/as-checked'));
const OUT = process.argv[2];

const EXTRA = [
  ['an unknown shop', 'https://shop.example.com/products/plain-hoodie'],
  ['Nike hoodie (link without the record’s product code)', 'https://www.nike.com/t/club-mens-pullover-fleece-hoodie-00eeWNwD'],
  ['UNIQLO page Fynd has no record of', 'https://www.uniqlo.com/us/en/products/E999999-000/00']
];

async function run(label, base, browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const rows = [];
  const links = R.RECORDS.map((r) => [`${r.brand} ${r.product.name} (${r.category})`, r.product.url, r]).concat(EXTRA.map(([n, u]) => [n, u, null]));
  for (const [name, url, record] of links) {
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#ffi-link');
    await page.fill('#ffi-link', url);
    await page.click('#ffi-link-go');
    await page.waitForSelector('#ffi-found[data-state]:not([data-state="loading"])', { timeout: 15000 });
    const state = await page.getAttribute('#ffi-found', 'data-state');
    let check = '';
    if (record && (state === 'automatic' || state === 'assisted')) {
      /* every value the page shows, against the brand's figure in Fynd's record */
      const shown = await page.$$eval('#ffi-found .ffi-values tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
      const heads = await page.$$eval('#ffi-found .ffi-values thead th', (ths) => ths.map((t) => t.firstChild.textContent));
      const g = record.charts.garment;
      const LABEL = { 'Chest width': 'chestWidth', 'Shoulder width': 'shoulderWidth', 'Body length': 'bodyLength', 'Sleeve length': 'sleeveLength' };
      let same = 0; let diff = 0;
      shown.forEach(([size, ...vals]) => vals.forEach((v, i) => { const dim = LABEL[heads[i + 1]]; const want = g.sizes[size] && g.sizes[size][dim] ? String(g.sizes[size][dim].text) : '—'; if (v === want) same += 1; else diff += 1; }));
      check = `${same} values match the record${diff ? `, ${diff} DIFFER` : ''} (${shown.length} sizes × ${heads.length - 1} measurements)`;
    }
    rows.push({ name, url, state, check });
  }
  if (OUT) await page.screenshot({ path: path.join(OUT, `links-${label}.png`) });
  await page.close();
  return rows;
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const prod = await run('production', base, browser);
  console.log('\nPRODUCTION DATA (as deployed today)');
  prod.forEach((r) => console.log(`  ${r.state.padEnd(11)} ${r.name}${r.check ? ` — ${r.check}` : ''}`));
  await asChecked(UQ_PAIR, async () => {
    const checked = await run('uq-checked', base, browser);
    console.log('\nWITH THE UNIQLO PAIR CHECKED (the test fixture: what a checked record does)');
    checked.filter((r) => /UNIQLO Sweat Pullover Hoodie|UNIQLO Sweatshirt/.test(r.name)).forEach((r) => console.log(`  ${r.state.padEnd(11)} ${r.name}${r.check ? ` — ${r.check}` : ''}`));
  });
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
