#!/usr/bin/env node
/* =========================================================
   Fynd — the offline test suites CI runs

   The lists below are the whole of what .github/workflows/ci.yml
   checks. Every suite on them is offline and needs no key:

     * each one stubs its own network, and scripts/ci-offline.js
       refuses any connection off this machine — a suite that tries
       one fails, even if it handled the refusal
     * each one is started with a clean environment (ENV_PASSED
       below), so a key, a Redis URL or a PRODUCT_SOURCE in the shell
       that runs this never reaches a test; the suites set the
       stand-ins they need themselves

   A suite counts as passed only when it exits 0 AND prints its own
   "N passed, 0 failed" with nothing skipped. A suite that skips
   itself ("Chromium could not launch here — skipping interface
   tests.") exits 0 and prints no count: here that is a failure,
   never a pass.

   Every scripts/test-*.js has to be named below — in a group, or in
   NOT_RUN with the reason — so a new suite never goes unrun without
   anyone deciding it should.

   Usage:
     node scripts/ci-tests.js                 the required suites, both groups
     node scripts/ci-tests.js node            no browser needed: npm ci, and ffmpeg on
                                                the PATH (test-demo-film unpacks the
                                                recorded session with it)
     node scripts/ci-tests.js browser         needs Playwright's Chromium:
                                                npm ci && npx playwright install chromium
                                                (or CHROME_PATH and PLAYWRIGHT_PATH naming others)
     node scripts/ci-tests.js known-failing   NOT_RUN's failing suites, on their own;
                                                CI runs this where it cannot fail the check
   ========================================================= */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');

const GROUPS = {
  node: [
    ['test-pipeline', 'intent, mapping, the verification gate, and the JSON /api/search returns; probe and route link shapes'],
    ['test-deadline', 'the request clock, offer lookups past their cap, the deadline race, probe vs /api/search parity'],
    ['test-messy', 'misspelt, slang, negative and conversational requests'],
    ['test-concepts', 'descriptive requests: what they mean, and what must not change'],
    ['test-reading', "the model's reading held to the shopper's words"],
    ['test-gemini', 'the interpreters (/api/interpret), and what did not change'],
    ['test-search', "the page's own reader and catalogue ranking, when no interpreter answers"],
    ['test-bench-messy-live', "the benchmark's requests and grading, through the real handlers on stand-ins"],
    ['test-cache', 'the search and offer caches, and what they may not change'],
    ['test-serper', 'the Serper fallback and its links'],
    ['test-serpapi', 'the SerpApi adapter, its links and its costs'],
    ['test-live-organic', "the Serper fallback end to end: organic results, read off the retailers' own pages"],
    ['test-auth', 'accounts, sessions, tokens, OAuth'],
    ['test-stripe', 'payments and subscriptions'],
    ['test-catalog-audit', 'the catalogue audit: every card proved from its row'],
    ['test-demo-audio', "the landing demo's sound: loudness, ducking, captions"],
    ['test-demo-film', "the landing demo film: length, order, every store frame real"]
  ],
  browser: [
    ['test-ui', 'the interface: the search box, its progress and allowance, palette, contrast, pricing and account pages'],
    ['test-e2e', 'the whole sign-in flow in a real browser, against the real handlers'],
    ['test-catalog-images', "the catalogue image extractor's gates, including its browser path"],
    ['test-record-demo', "the demo recorder's tool paths and rules, and its retailer test in a browser"]
  ]
};

/* Every other scripts/test-*.js, and why CI does not hold a pull request
   to it. */
const NOT_RUN = {
  'test-catalog-prices': {
    knownFailing: true,
    why: 'fails one test on main (checked at 2bac8c1) and on the messy-search branch alike — "the live shape: ' +
      'the endpoint the page asks answers instead" expects 49.9 and reads undefined. An existing issue, investigated on its own; ' +
      'CI runs it every time (known-failing) where it cannot fail the check, so the result stays in view. ' +
      'Move it back into "browser" once it passes.'
  }
};

/* What a suite inherits from the shell. Nothing else: no key, no store
   URL, no provider choice. */
const ENV_PASSED = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS',
  'CHROME_PATH', 'PLAYWRIGHT_PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'FFMPEG_PATH', 'DISPLAY', 'XDG_RUNTIME_DIR'];

const SUITE_TIMEOUT_MS = 10 * 60 * 1000;
const COUNT = /(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/g;
const ACTIONS = process.env.GITHUB_ACTIONS === 'true';

function unlisted() {
  const named = new Set([...GROUPS.node, ...GROUPS.browser].map(([name]) => name).concat(Object.keys(NOT_RUN)));
  return fs.readdirSync(__dirname)
    .filter((f) => /^test-.*\.js$/.test(f))
    .map((f) => f.replace(/\.js$/, ''))
    .filter((name) => !named.has(name));
}

/* Where the browser suites find Playwright and its Chromium when the
   shell does not say: the copy npm ci installed, and the browser
   npx playwright install put beside it. */
function browserPaths() {
  const found = {};
  try {
    found.PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH || path.dirname(require.resolve('playwright/package.json', { paths: [REPO] }));
    const chrome = process.env.CHROME_PATH || require(found.PLAYWRIGHT_PATH).chromium.executablePath();
    if (fs.existsSync(chrome)) found.CHROME_PATH = chrome;
  } catch (err) { /* not installed: the suites' own defaults, and a skip is a failure */ }
  return found;
}

function run(name, offlineLog) {
  const env = browserPaths();
  for (const key of ENV_PASSED) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.NODE_OPTIONS = `--require ${path.join(__dirname, 'ci-offline.js')}`;
  env.FYND_OFFLINE_LOG = offlineLog;

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, `${name}.js`)], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { output += `\n[ci-tests] killed after ${SUITE_TIMEOUT_MS / 1000}s\n`; child.kill('SIGKILL'); }, SUITE_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ name, code, signal, output, seconds: (Date.now() - started) / 1000 });
    });
  });
}

/* passed only on exit 0, a count, nothing failed, nothing skipped, and
   no connection off this machine */
function verdict(result, offlineLog) {
  const counts = [...result.output.matchAll(COUNT)].pop();
  const refused = fs.existsSync(offlineLog) ? fs.readFileSync(offlineLog, 'utf8').trim() : '';
  const problems = [];
  if (result.code !== 0) problems.push(result.signal ? `killed (${result.signal})` : `exited ${result.code}`);
  if (!counts) problems.push('printed no "N passed, N failed" count — it did not run its tests');
  else {
    if (Number(counts[1]) === 0) problems.push('ran no tests');
    if (Number(counts[2]) > 0) problems.push(`${counts[2]} failed`);
    if (Number(counts[3]) > 0) problems.push(`${counts[3]} skipped`);
  }
  if (refused) problems.push(`tried to reach the network:\n${refused.replace(/^/gm, '      ')}`);
  return { counts: counts ? counts[0] : 'no count', problems };
}

async function runAll(names, label) {
  const results = [];
  for (const name of names) {
    const offlineLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-ci-')), 'refused.log');
    const result = await run(name, offlineLog);
    const { counts, problems } = verdict(result, offlineLog);
    const ok = problems.length === 0;
    results.push({ name, ok, counts, problems, seconds: result.seconds });

    if (ACTIONS) {
      console.log(`::group::${ok ? 'pass' : 'FAIL'}  ${name}  (${counts}, ${result.seconds.toFixed(1)}s)`);
      process.stdout.write(result.output);
      console.log('::endgroup::');
    } else if (!ok) {
      process.stdout.write(result.output);
    }
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name.padEnd(22)} ${counts.padEnd(32)} ${result.seconds.toFixed(1)}s`);
    for (const problem of problems) console.log(`      ${problem}`);
    if (!ok && ACTIONS) console.log(`::error title=${label}: ${name}::${problems.join('; ').replace(/\n\s*/g, ' ')}`);
  }
  return results;
}

function summarise(label, results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${label}: ${results.length - failed.length} of ${results.length} suites passed` +
    (failed.length ? ` — failed: ${failed.map((r) => r.name).join(', ')}` : ''));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.ok ? '✅' : '❌'} | \`${r.name}\` | ${r.counts} | ${r.seconds.toFixed(1)}s | ${r.problems.join('; ').replace(/\n\s*/g, ' ').replace(/\|/g, '\\|')} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### ${label}\n\n| | Suite | Count | Time | Problem |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n`);
  }
  return failed.length;
}

function reportNotRun() {
  console.log('\nNot run as required checks:');
  for (const [name, { why }] of Object.entries(NOT_RUN)) {
    console.log(`  ${name}: ${why}`);
    if (ACTIONS) console.log(`::notice title=Not a required check: ${name}::${why}`);
  }
}

async function main() {
  const which = process.argv[2] || 'required';
  const choices = ['required', 'node', 'browser', 'known-failing'];
  if (!choices.includes(which)) {
    console.error(`usage: node scripts/ci-tests.js [${choices.join('|')}]`);
    process.exit(2);
  }

  const missing = unlisted();
  if (missing.length) {
    console.error(`Not named in scripts/ci-tests.js: ${missing.join(', ')}.\n` +
      'Add each to a group, or to NOT_RUN with the reason CI should not run it.');
    process.exit(1);
  }

  if (which === 'known-failing') {
    const names = Object.keys(NOT_RUN).filter((name) => NOT_RUN[name].knownFailing);
    reportNotRun();
    console.log('');
    const results = await runAll(names, 'Known failing (not a required check)');
    const failed = summarise('Known failing (not a required check)', results);
    for (const r of results) {
      if (ACTIONS) {
        console.log(r.ok
          ? `::warning title=${r.name} now passes::Move it from NOT_RUN back into the "browser" group in scripts/ci-tests.js.`
          : `::warning title=Known failure: ${r.name}::${r.problems.join('; ').replace(/\n\s*/g, ' ')} — not a required check; see NOT_RUN in scripts/ci-tests.js.`);
      }
    }
    process.exit(failed ? 1 : 0);
  }

  const groups = which === 'required' ? ['node', 'browser'] : [which];
  let failed = 0;
  for (const group of groups) {
    console.log(`\n${group} suites\n`);
    failed += summarise(`Required (${group})`, await runAll(GROUPS[group].map(([name]) => name), `Required (${group})`));
  }
  reportNotRun();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
