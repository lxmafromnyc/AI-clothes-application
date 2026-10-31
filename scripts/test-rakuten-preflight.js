#!/usr/bin/env node
/* =========================================================
   Fynd — the Rakuten feed's preflight and sample validation, offline

   scripts/rakuten-preflight.js: every setting the SFTP download needs,
   in a shape that can work, and no credential ever printed.
   scripts/rakuten-sample.js: a whole file and a cut-off gzipped sample,
   read through the sync's own import, and each way one can fail — the
   wrong advertiser, links off UNIQLO's site, too many rejected rows, no
   licence, a file that isn't Rakuten's.

   Every MID, SID, code (E97xxxx), name ("FIXTURE") and credential here
   is invented. Nothing connects to anything.

   Usage: node scripts/test-rakuten-preflight.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const preflight = require('./rakuten-preflight');
const sample = require('./rakuten-sample');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 10).join('\n        ') : err}`); }
}
const section = (name) => console.log(`\n${name}`);

const MID = '99999';
const SID = '88888';
const USER = 'fixture-user';
const PASS = 'FIXTURE-pa55 "word" \\ with:colon';
const FP = `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`;
const GOOD = { RAKUTEN_SFTP_USER: USER, RAKUTEN_SFTP_PASSWORD: PASS, RAKUTEN_UNIQLO_MID: MID, RAKUTEN_SID: SID, RAKUTEN_SFTP_HOSTKEY_SHA256: FP, UNIQLO_FEED_LICENSED_FIELDS: 'images,colours,sizes,price,stock,description' };
const capture = (fn) => { const out = []; const code = fn({ log: (s) => out.push(s), error: (s) => out.push(s) }); return { code, text: out.join('\n') }; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-rakuten-preflight-'));

/* one variant line, all 38 fields, in Rakuten's documented positions */
const code = (i) => `E97${String(i).padStart(4, '0')}-000`;
const page = (c) => `https://www.uniqlo.com/us/en/products/${c}/00`;
const track = (c) => `https://click.linksynergy.com/link?id=FIXTUREID&offerid=${MID}.${c.slice(1, 7)}&type=15&murl=${encodeURIComponent(page(c))}`;
function line(i, size, o) {
  const opts = o || {};
  const c = code(i);
  const f = new Array(38).fill('');
  f[0] = String(500000 + i);
  f[1] = `FIXTURE Men's Sweat Hoodie ${i}`;
  f[2] = `${c.slice(1, 7)}-09-${size}`;
  f[3] = 'Men';
  f[4] = 'Tops~~Sweatshirts & Hoodies';
  f[5] = opts.url || track(c);
  f[6] = `https://image.uniqlo.com/UQ/ST3/AsianCommon/imagesgoods/${c.slice(1, 7)}/item/goodsimages/goods_09_${c.slice(1, 7)}_3x4.jpg`;
  f[13] = '39.90';
  f[16] = 'UNIQLO';
  f[22] = 'in-stock';
  f[24] = '60';
  f[25] = 'USD';
  f[29] = 'Hoodies';
  f[30] = size;
  f[32] = '09 BLACK';
  f[33] = 'Male';
  f[35] = 'Adult';
  return f.join('|');
}
const lines = (from, to, o) => { const out = []; for (let i = from; i < to; i += 1) ['S', 'M', 'L'].forEach((s) => out.push(line(i, s, o && o(i)))); return out; };
const fileOf = (ls, o) => [`HDR|${(o && o.mid) || MID}|FIXTURE UNIQLO USA|10/30/2026 06:00:00`, ...ls, `TRL|${ls.length}`].join('\n');
const run = (buf, extra) => sample.validate(buf, Object.assign({ lines: 2000, licensed: ['images', 'colours', 'sizes', 'price', 'stock'], mid: MID, now: '2026-10-31T00:00:00.000Z', examples: 2 }, extra || {}));

section('the preflight: settings, never their secrets');

test('everything set: ready, the file names and the fingerprint in OpenSSH form — and neither credential printed, nor its length', () => {
  const r = preflight.check(GOOD);
  assert.strictEqual(r.ready, true, JSON.stringify(r.checks));
  assert.deepStrictEqual(r.files, { full: `${MID}_${SID}_mp.txt.gz`, delta: `${MID}_${SID}_mp_delta.txt.gz` });
  assert.strictEqual(r.host, 'aftp.linksynergy.com', 'the host comes from the adapter, never the environment');
  assert.strictEqual(r.fingerprint, FP);
  assert.strictEqual(r.dir, '/');
  ['~/', '/12345/', '~/12345/'].forEach((d) => assert.strictEqual(preflight.check(Object.assign({}, GOOD, { RAKUTEN_SFTP_DIR: d })).dir, d, d));
  ['~', 'x/', '/a/../', '~/../', '/a b/'].forEach((d) => assert.strictEqual(preflight.check(Object.assign({}, GOOD, { RAKUTEN_SFTP_DIR: d })).ready, false, d));
  const shown = [JSON.stringify(r), capture((d) => preflight.main([], Object.assign({ env: GOOD }, d))).text, capture((d) => preflight.main(['--json'], Object.assign({ env: GOOD }, d))).text].join('\n');
  [USER, PASS, 'fixture-user', 'pa55'].forEach((secret) => assert.ok(!shown.includes(secret), `printed ${secret}`));
});

test('nothing set: not ready, each missing setting named as a secret or a variable, exit 1', () => {
  const r = preflight.check({});
  assert.strictEqual(r.ready, false);
  const failed = r.checks.filter((c) => c.level === 'error').map((c) => c.name);
  assert.deepStrictEqual(failed, ['RAKUTEN_SFTP_USER', 'RAKUTEN_SFTP_PASSWORD', 'RAKUTEN_UNIQLO_MID', 'RAKUTEN_SID', 'RAKUTEN_SFTP_HOSTKEY_SHA256']);
  assert.match(r.checks.find((c) => c.name === 'RAKUTEN_SFTP_USER').detail, /repository secret/);
  assert.match(r.checks.find((c) => c.name === 'RAKUTEN_UNIQLO_MID').detail, /repository variable/);
  assert.strictEqual(r.files, null);
  const out = capture((d) => preflight.main([], Object.assign({ env: {} }, d)));
  assert.strictEqual(out.code, 1);
  assert.match(out.text, /Not ready/);
});

test('the fingerprint: with or without "SHA256:" and padding; an MD5 one, a short one or junk is refused with why', () => {
  const raw = FP.slice(7);
  [FP, raw, `${raw}=`, ` ${FP} `].forEach((v) => assert.strictEqual(preflight.fingerprint(v).value, FP, v));
  assert.match(preflight.fingerprint('16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48').error, /MD5/);
  assert.match(preflight.fingerprint('SHA256:abc').error, /43 base64/);
  assert.match(preflight.fingerprint('not a key at all, clearly not a key at all!!').error, /not a SHA-256/);
});

test('malformed settings: a user with a colon, a password with a line break, IDs that aren’t numbers, an unlicensable field, a bad directory', () => {
  const r = preflight.check(Object.assign({}, GOOD, { RAKUTEN_SFTP_USER: 'a:b', RAKUTEN_SFTP_PASSWORD: 'x\ny', RAKUTEN_UNIQLO_MID: '12a', RAKUTEN_SID: '', UNIQLO_FEED_LICENSED_FIELDS: 'images,measurements', RAKUTEN_SFTP_DIR: '../etc' }));
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.strictEqual(r.ready, false);
  ['RAKUTEN_SFTP_USER', 'RAKUTEN_SFTP_PASSWORD', 'RAKUTEN_UNIQLO_MID', 'RAKUTEN_SID', 'UNIQLO_FEED_LICENSED_FIELDS', 'RAKUTEN_SFTP_DIR'].forEach((k) => assert.strictEqual(by[k].level, 'error', k));
  assert.match(by.UNIQLO_FEED_LICENSED_FIELDS.detail, /measurements/);
  assert.ok(!JSON.stringify(r).includes('x\ny'));
});

test('no licensed fields is a warning, not a failure: the core fields can still be synced', () => {
  const r = preflight.check(Object.assign({}, GOOD, { UNIQLO_FEED_LICENSED_FIELDS: '' }));
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.checks.find((c) => c.name === 'UNIQLO_FEED_LICENSED_FIELDS').level, 'warning');
});

test('--github-output writes public values only, and nothing when not ready', () => {
  const out = path.join(tmp, 'gh-output');
  fs.writeFileSync(out, '');
  capture((d) => preflight.main(['--github-output'], Object.assign({ env: Object.assign({ GITHUB_OUTPUT: out }, GOOD) }, d)));
  const written = fs.readFileSync(out, 'utf8');
  assert.match(written, new RegExp(`^full_file=${MID}_${SID}_mp\\.txt\\.gz$`, 'm'));
  assert.match(written, /^host=aftp\.linksynergy\.com$/m);
  assert.ok(!written.includes(USER) && !written.includes('pa55'));
  fs.writeFileSync(out, '');
  capture((d) => preflight.main(['--github-output'], Object.assign({ env: { GITHUB_OUTPUT: out } }, d)));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), '');
  assert.strictEqual(capture((d) => preflight.main(['--bogus'], Object.assign({ env: GOOD }, d))).code, 2);
});

section('a sample of the feed, through the sync’s own import');

test('a whole file: read as one, its trailer checked, every field the import relies on measured, and accepted', () => {
  const r = run(Buffer.from(fileOf(lines(0, 20))));
  assert.strictEqual(r.verdict, 'accepted', r.blockers.join(' '));
  assert.strictEqual(r.mode, 'whole file');
  assert.deepStrictEqual([r.header.mid, r.header.declared], [MID, 60]);
  assert.deepStrictEqual([r.lines.read, r.lines.productCodes, r.lines.skus, r.lines.skusPerProduct], [60, 20, 60, 3], 'a line per variant');
  ['sku', 'productPage', 'uniqloCode', 'trackingLink', 'imageOnUniqloHost', 'clothingClass', 'size', 'colour', 'gender', 'age', 'retailPrice'].forEach((k) => assert.strictEqual(r.lines.filled[k].percent, 100, k));
  assert.deepStrictEqual([r.import.products, r.import.rejected, r.import.byCategory], [20, 0, { 'sweatshirts-hoodies': 20 }]);
  assert.deepStrictEqual(r.import.byLine, { men: 20 });
  assert.strictEqual(r.import.withSizes.percent, 100);
  assert.strictEqual(r.import.examples.length, 2);
});

test('a cut-off gzipped download: the partial line dropped, the trailer added for parsing only, and it says it is a sample — never a count of the whole', () => {
  const gz = zlib.gzipSync(Buffer.from(fileOf(lines(0, 3000))));
  const r = run(gz.subarray(0, Math.floor(gz.length / 3)));
  assert.strictEqual(r.verdict, 'accepted', r.blockers.join(' '));
  assert.deepStrictEqual([r.mode, r.gzip, r.header.declared], ['sample', 'cut off', null]);
  assert.ok(r.lines.read > 0 && r.lines.read < 9000);
  assert.strictEqual(r.import.rejected, 0, 'no half line reached the import');
  assert.ok(r.warnings.some((w) => /trailer was added for parsing only/.test(w) && /nothing here says how many products the whole file holds/.test(w)));
  const limited = run(zlib.gzipSync(Buffer.from(fileOf(lines(0, 100)))), { lines: 30 });
  assert.deepStrictEqual([limited.mode, limited.lines.read], ['sample', 30], '--lines keeps a whole file to a sample too');
});

test('the wrong advertiser: refused by the header check and by the import, as a sync would be', () => {
  const r = run(Buffer.from(fileOf(lines(0, 5), { mid: '12345' })));
  assert.strictEqual(r.verdict, 'refused');
  assert.ok(r.blockers.some((b) => /advertiser ID is 12345, not RAKUTEN_UNIQLO_MID \(99999\)/.test(b)));
  assert.ok(r.blockers.some((b) => /wrong-advertiser/.test(b)));
  const unchecked = run(Buffer.from(fileOf(lines(0, 5), { mid: '12345' })), { mid: null });
  assert.ok(unchecked.warnings.some((w) => /wasn’t checked/.test(w)));
});

test('links off UNIQLO’s US product pages: every row rejected, and the reason named before any sync', () => {
  const r = run(Buffer.from(fileOf(lines(0, 10, () => ({ url: 'https://click.linksynergy.com/link?id=X&murl=https%3A%2F%2Fwww.example-shop.com%2Fp%2F1' })))));
  assert.strictEqual(r.verdict, 'refused');
  assert.strictEqual(r.lines.filled.uniqloCode.percent, 0);
  assert.ok(r.blockers.some((b) => /UNIQLO US product page/.test(b)));
});

test('more than 10% of rows rejected is refused, as the sync refuses it; under 10% is accepted with a warning', () => {
  const bad = (i) => (i % 4 === 0 ? { url: 'https://www.example-shop.com/x' } : null);
  const r = run(Buffer.from(fileOf(lines(0, 40, bad))));
  assert.strictEqual(r.verdict, 'refused');
  assert.ok(r.blockers.some((b) => /a sync refuses a feed with more than 10%/.test(b)));
  const few = run(Buffer.from(fileOf(lines(0, 40, (i) => (i === 3 ? { url: 'https://www.example-shop.com/x' } : null)))));
  assert.strictEqual(few.verdict, 'accepted');
  assert.ok(few.warnings.some((w) => /lead to a UNIQLO US product page/.test(w)));
});

test('no licence given: accepted for the core fields, with photos, sizes and price dropped and said so', () => {
  const r = run(Buffer.from(fileOf(lines(0, 5))), { licensed: [] });
  assert.strictEqual(r.verdict, 'accepted');
  assert.deepStrictEqual([r.import.withPhotos.percent, r.import.withSizes.percent, r.import.withPrice.percent], [0, 0, 0]);
  assert.ok(r.warnings.some((w) => /No licensed fields/.test(w)));
});

test('not a Rakuten file, or not gunzipped: refused plainly; the command exits 1, or 2 on a usage error', () => {
  assert.strictEqual(run(Buffer.from('{"format":"fynd-catalog-feed"}')).verdict, 'refused');
  const f = path.join(tmp, 'feed.txt.gz');
  fs.writeFileSync(f, zlib.gzipSync(Buffer.from(fileOf(lines(0, 5), { mid: '12345' }))));
  const out = capture((d) => sample.main(['--file', f, '--mid', MID], Object.assign({ env: {} }, d)));
  assert.strictEqual(out.code, 1);
  assert.match(out.text, /A sync would refuse a file like this/);
  assert.match(out.text, /no catalogue is connected until one has been synced, reviewed and committed/);
  fs.writeFileSync(f, zlib.gzipSync(Buffer.from(fileOf(lines(0, 5)))));
  assert.strictEqual(capture((d) => sample.main(['--file', f, '--mid', MID, '--licensed', 'images'], Object.assign({ env: {} }, d))).code, 0);
  assert.strictEqual(capture((d) => sample.main(['--lines', '5'], Object.assign({ env: {} }, d))).code, 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
