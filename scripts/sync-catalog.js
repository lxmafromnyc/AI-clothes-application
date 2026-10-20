#!/usr/bin/env node
/* =========================================================
   Fynd — sync a brand's catalogue from its authorized feed

   Reads one feed (a file, or the source's authorized API), checks every
   row (api/_catalog/import.js), merges it with the catalogue already
   committed (api/_catalog/sync.js), and — only if every check passes —
   writes the next catalogue. A person then reads the report and the
   diff, and commits the file; nothing here commits or deploys.

   Usage:
     node scripts/sync-catalog.js --source uniqlo-us --file <feed.json|.jsonl|.tsv|.csv>
     node scripts/sync-catalog.js --source uniqlo-us --file <MID_SID_mp.txt>   (Rakuten Product Catalog)
     node scripts/sync-catalog.js --source uniqlo-us --api

   Options:
     --complete             the file lists every live product (product-feed
                            rows only; a Fynd feed says so itself)
     --generated-at <ISO>   when the file was generated (product-feed rows)
     --licensed <list>      the fields the licence covers: images, colours,
                            sizes, price, stock (else the source's env
                            variable, e.g. UNIQLO_FEED_LICENSED_FIELDS)
     --out <path>           where to write the catalogue
                            (default api/_catalog/data/<source>.json)
     --status <path>        where to record this attempt
                            (default api/_catalog/data/<source>.status.json)
     --dry-run              check and report; write nothing
     --allow-mass-removal   accept a complete feed that removes over half
     --allow-fixture        accept a feed marked as a fixture — only with an
                            --out outside api/_catalog/data
     --now <ISO>            the time to record (tests)

   With --api, the address and credential come from the source's
   environment variables (UNIQLO_FEED_URL, UNIQLO_FEED_TOKEN) and the
   host must be one the source's adapter authorizes. The credential is
   never printed. Exit 0 on success, 1 when the sync was refused or the
   feed couldn't be read (the catalogue is then left as it was, and the
   attempt is recorded in the status file), 2 on a usage error.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { read, FeedError } = require('../api/_catalog/import');
const { sync } = require('../api/_catalog/sync');
const { fetchFeed, redact } = require('../api/_catalog/fetch');

const REPO = path.join(__dirname, '..');
const DATA = path.join(REPO, 'api/_catalog/data');
const SOURCES = { 'uniqlo-us': () => require('../api/_catalog/sources/uniqlo-us') };

function args(argv) {
  const out = {};
  const flags = ['complete', 'api', 'dry-run', 'allow-mass-removal', 'allow-fixture'];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    const key = a.slice(2);
    if (flags.includes(key)) out[key] = true;
    else if (['source', 'file', 'generated-at', 'licensed', 'out', 'status', 'now'].includes(key)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      out[key] = argv[i += 1];
    } else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; }
}

async function main(argv, deps) {
  const d = Object.assign({ env: process.env, log: console.log, error: console.error }, deps || {});
  let o;
  try { o = args(argv); } catch (err) { d.error(err.message); return 2; }
  const load = SOURCES[o.source];
  if (!load) { d.error(`--source must be one of ${Object.keys(SOURCES).join(', ')}`); return 2; }
  if (Boolean(o.file) === Boolean(o.api)) { d.error('Give exactly one of --file <path> or --api'); return 2; }
  const adapter = load();
  const out = path.resolve(o.out || path.join(DATA, adapter.catalogFile));
  const statusFile = path.resolve(o.status || path.join(DATA, `${adapter.id}.status.json`));
  const customerFacing = out.startsWith(`${DATA}${path.sep}`);
  if (o['allow-fixture'] && customerFacing) { d.error('--allow-fixture is only for an --out outside api/_catalog/data: a fixture is never a customer-facing catalogue'); return 2; }
  const now = o.now ? new Date(o.now) : new Date();
  if (Number.isNaN(now.getTime())) { d.error('--now must be a date'); return 2; }
  const licensed = (o.licensed !== undefined ? o.licensed.split(',') : adapter.LICENSED.concat(adapter.licensedFromEnv())).map((s) => s.trim()).filter(Boolean);
  const previous = readJson(out);
  const token = d.env[adapter.env.token];

  const record = (status) => { if (!o['dry-run']) writeAtomic(statusFile, status); };
  const fail = (reason, message, report) => {
    const safe = redact(message, token);
    d.error(`Catalogue sync refused (${reason}): ${safe}`);
    if (report) d.log(JSON.stringify(report, null, 2));
    record({
      source: adapter.id,
      lastAttempt: now.toISOString(),
      lastAttemptOk: false,
      reason,
      error: safe,
      lastSuccessfulSync: previous && previous.lastSuccessfulSync ? previous.lastSuccessfulSync : null,
      products: previous && Array.isArray(previous.products) ? previous.products.length : 0,
      /* this attempt's feed, when it got far enough to be read */
      feed: report ? { rows: report.read + report.rejected + report.discontinued + report.duplicateCount, read: report.read, rejected: report.rejected, duplicates: report.duplicateCount, rejectedRows: report.rejectedRows.slice(0, 20) } : null
    });
    return 1;
  };

  let body;
  try {
    if (o.file) {
      const file = path.resolve(o.file);
      const stat = fs.statSync(file);
      if (!stat.isFile()) return fail('not-a-file', `${o.file} is not a file`);
      body = fs.readFileSync(file, 'utf8');
    } else {
      body = await fetchFeed(adapter, { env: d.env, fetch: d.fetch });
    }
  } catch (err) {
    return fail(err instanceof FeedError ? err.reason : 'unreadable', err instanceof FeedError ? err.message : `The feed couldn’t be read: ${err && err.code === 'ENOENT' ? 'no such file' : err && err.message}`);
  }

  let imported;
  try {
    imported = read(body, adapter, {
      licensed,
      complete: o.complete === true,
      generatedAt: o['generated-at'] ? new Date(o['generated-at']).toISOString() : null,
      fixture: false,
      /* a Rakuten file must be from the advertiser configured for this source */
      mid: adapter.RAKUTEN && d.env[adapter.RAKUTEN.midEnv] ? d.env[adapter.RAKUTEN.midEnv] : null,
      now: now.toISOString()
    });
  } catch (err) {
    return fail(err instanceof FeedError ? err.reason : 'invalid-feed', err.message);
  }
  if (imported.header.fixture && customerFacing) return fail('fixture', 'This feed is marked as a fixture and can never be written to the customer-facing catalogue.');

  const result = sync(previous && previous.format === 'fynd-catalog' && previous.source === adapter.id ? previous : null, imported, adapter, {
    now: now.toISOString(),
    allowMassRemoval: o['allow-mass-removal'] === true,
    allowFixture: o['allow-fixture'] === true,
    sourceKind: o.api ? 'api' : 'file'
  });
  if (!result.ok) return fail(result.reason, result.error, result.report);

  d.log(JSON.stringify(result.report, null, 2));
  if (o['dry-run']) { d.log('Dry run: nothing written.'); return 0; }
  writeAtomic(out, result.catalog);
  record({
    source: adapter.id,
    lastAttempt: now.toISOString(),
    lastAttemptOk: true,
    reason: null,
    error: null,
    lastSuccessfulSync: result.catalog.lastSuccessfulSync,
    products: result.catalog.products.length,
    feed: { rows: result.report.read + result.report.rejected + result.report.discontinued + result.report.duplicateCount, read: result.report.read, rejected: result.report.rejected, duplicates: result.report.duplicateCount, rejectedRows: result.report.rejectedRows.slice(0, 20) },
    coverage: result.report.coverage
  });
  d.log(`Wrote ${result.catalog.products.length} products to ${path.relative(REPO, out)}. Read the report and the diff before committing it.`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err && err.message); process.exit(1); });
}

module.exports = { main };
