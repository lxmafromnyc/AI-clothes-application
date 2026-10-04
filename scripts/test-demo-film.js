#!/usr/bin/env node
/* =========================================================
   Fynd — the homepage film

   What the film has to be, checked against the session it is cut from:

     50 to 60 seconds, desktop and phone;
     the four requests, in order, each typed, searched, its results, one
       chosen and opened at its store, one after the other;
     every frame of a store page is from that store's own window in the
       session — the page the recorder verified, never a page from
       before it loaded or after it left — and the session holds a
       verified product page for every store the film opens;
     the product photographs are the session's own results frames;
     the narration lines never overlap and end before the film does;
     the keystrokes the sound is written to fall while the request is
       being typed;
     motion blur never takes fewer than one or more than eleven samples;
     a drawn frame is the film's size and not blank.

   Offline:  node scripts/test-demo-film.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = require('./demo-film');

const DEMO = path.join(__dirname, '..', 'assets', 'demo');
const FOOTAGE = path.join(DEMO, 'footage');
const manifest = JSON.parse(fs.readFileSync(path.join(DEMO, 'narration', 'manifest.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(DEMO, 'demo-report.json'), 'utf8'));
const QUERIES = [
  'black oversized hoodie under $80',
  'lightweight jacket for fall under $150',
  'BAPE shark hoodie under $400',
  'sage green linen midi dress under $120'
];

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
  });
}

const session = (name) => JSON.parse(fs.readFileSync(path.join(FOOTAGE, `${name}.session.json`), 'utf8'));

test('the facts set in type are the session\'s own: the four requests, in order, each with a real product', () => {
  const data = F.facts();
  assert.deepStrictEqual(data.map((d) => d.query), QUERIES);
  for (const d of data) {
    assert.ok(d.brand && d.name && /^\$\d/.test(d.price) && /\./.test(d.host), JSON.stringify(d));
  }
});

for (const key of ['desktop', 'mobile']) {
  const e = F.plan(key);
  const fmt = F.FORMATS[key];
  const s = session(fmt.name);

  test(`${fmt.name}: ${e.duration.toFixed(2)}s, between 50 and 60 seconds`, () => {
    assert.ok(e.duration >= 50 && e.duration <= 60, `${e.duration}s`);
  });

  test(`${fmt.name}: four searches, each typed, searched, its results, one chosen and opened at its store, in turn`, () => {
    assert.strictEqual(e.shots.length, 4);
    e.shots.forEach((shot, k) => {
      const order = ['start', 'lastKey', 'submit', 'revealStart', 'liveStart', 'click', 'heroStart', 'heroEnd', 'handoff', 'storeEnd'];
      for (let i = 1; i < order.length; i += 1) {
        assert.ok(shot[order[i - 1]] < shot[order[i]], `search ${k + 1}: ${order[i - 1]} ${shot[order[i - 1]].toFixed(2)} is not before ${order[i]} ${shot[order[i]].toFixed(2)}`);
      }
      const next = e.shots[k + 1];
      if (next) assert.ok(shot.end <= next.start, `search ${k + 1} runs into search ${k + 2}`);
    });
    assert.ok(e.shots[3].end <= e.close.start, 'the last store runs into the close');
  });

  test(`${fmt.name}: the session's moments the film is built on are where the session says they are`, () => {
    fmt.searches.forEach((sh, k) => {
      const rec = s.searches[k];
      assert.deepStrictEqual(sh.retail, rec.retailer, `search ${k + 1}: the store window`);
      assert.ok(sh.from <= sh.lastKey && sh.lastKey < sh.press, `search ${k + 1}: typing`);
      assert.ok(sh.press <= rec.searched + 0.05, `search ${k + 1}: Search is pressed by the time the session logs it`);
      assert.ok(sh.liveFrom >= rec.results - 0.05 && sh.liveFrom < sh.click, `search ${k + 1}: the results are live`);
      assert.ok(sh.click < rec.retailer[0], `search ${k + 1}: chosen before the store opens`);
    });
  });

  test(`${fmt.name}: every frame of every store page is from inside that store's window in the session`, () => {
    e.shots.forEach((shot, k) => {
      const st = fmt.stores[k];
      const src = st.time ? session(st.footage === 'desktop' ? 'fynd-demo' : 'fynd-demo-mobile').searches[k].retailer : s.searches[k].retailer;
      if (st.time) assert.deepStrictEqual(st.time, src, 'the borrowed page is the same search\'s store window');
      for (let t = shot.handoff; t <= shot.storeEnd + 1e-6; t += 1 / F.FPS) {
        const pageAt = Math.min(t, shot.storeEnd) - shot.dStore;
        assert.ok(pageAt >= src[0] && pageAt <= src[1], `search ${k + 1}: the page at ${t.toFixed(2)}s is session ${pageAt.toFixed(2)}s, outside ${src}`);
        if (st.until) assert.ok(pageAt <= st.until + 1e-6, `search ${k + 1}: session ${pageAt.toFixed(2)}s is after the page has gone`);
      }
    });
  });

  test(`${fmt.name}: each store opened is a product page the recorder verified on camera, no challenge or block page`, () => {
    assert.strictEqual(report.everyHandoffShown, true);
    const data = F.facts();
    report.searches.forEach((r, k) => {
      const opened = r.opened[key];
      assert.ok(opened && opened.shown === true, `search ${k + 1}: the store was not shown on camera`);
      assert.strictEqual(r.typed, QUERIES[k]);
      assert.ok(data[k].host.endsWith(opened.retailer) || opened.retailer.endsWith(data[k].host), `search ${k + 1}: ${data[k].host} against ${opened.retailer}`);
      assert.ok(/^https:\/\//.test(opened.opened), `search ${k + 1}: opened ${opened.opened}`);
    });
  });

  test(`${fmt.name}: the narration never overlaps, and ends before the film does`, () => {
    const lines = [...e.vo].sort((a, b) => a.at - b.at);
    lines.forEach((l, i) => {
      assert.ok(manifest.lines[l.key], `no recording for "${l.key}"`);
      const end = l.at + manifest.lines[l.key].duration;
      const next = lines[i + 1];
      if (next) assert.ok(end <= next.at - 0.1, `${l.key} ends at ${end.toFixed(2)}s, ${next.key} starts at ${next.at.toFixed(2)}s`);
      else assert.ok(end <= e.duration - 0.5, `${l.key} ends ${(e.duration - end).toFixed(2)}s before the end`);
    });
    const fin = e.vo.find((v) => v.key === 'finale');
    assert.ok(e.close.start + e.finaleSplit > fin.at + 0.8 && e.close.start + e.finaleSplit < fin.at + manifest.lines.finale.duration - 0.6,
      '"Fynd finds it." is set where it is said');
  });

  test(`${fmt.name}: every line is said just after the moment it is about — never before it`, () => {
    const tl = F.filmTimeline(new F.Film(key, F.facts()));
    const line = (k) => tl.lines.find((l) => l.key === k);
    const m = tl.marks;
    const after = (k, moment, within, what) => {
      const d = line(k).speech - moment;
      assert.ok(d >= -0.02 && d <= within, `"${k}" starts ${d.toFixed(2)} s after ${what}`);
    };
    const wordAt = (k, w) => line(k).at + F.wordIn(k, w);
    after('hook', 0, 1.0, 'the film starts');
    after('describe', m.searches[0].start, 0.8, 'the homepage is up');
    after('look', m.searches[0].results, 0.6, 'the first results appear');
    after('pick', m.searches[0].select, 0.3, 'the product is chosen');
    after('switch', m.searches[1].start, 1.2, 'the jacket search begins');
    assert.ok(Math.abs(wordAt('switch', 'Same') - m.searches[1].results) < 0.15, '"Same idea." is not with the jackets arriving');
    after('rare', m.searches[2].start, 0.6, 'the BAPE search begins');
    after('there', m.searches[2].results + 0.3, 0.6, 'the BAPE listings have risen');
    after('finale', m.close.start, 0.5, 'the close begins');
    /* "...at the store" heard as the store opens; "...hard to find" as
       the dark stage opens; "color" as "Sage green" lifts out */
    assert.ok(Math.abs(wordAt('pick', 'store') - m.searches[0].handoff) < 0.6, '"store" is not with the store');
    assert.ok(Math.abs(wordAt('rare', 'hard') - m.searches[2].submit) < 0.6, '"hard to find" is not with the dark stage');
    assert.ok(Math.abs(wordAt('exact', 'color') - m.searches[3].words[0]) < 0.15, '"color" is not with "Sage green"');
    /* the closing type changes on the word "Fynd" */
    assert.ok(Math.abs(m.close.line2 - wordAt('finale', 'Find')) < 0.01, '"Fynd finds it." is not set on its word');
  });

  test(`${fmt.name}: the keystrokes the sound follows fall while each request is being typed`, () => {
    const film = new F.Film(key, F.facts());
    const tl = F.filmTimeline(film);
    assert.strictEqual(tl.film, true);
    tl.searches.forEach((sh, k) => {
      assert.ok(sh.keys.length >= 10, `search ${k + 1}: ${sh.keys.length} keys`);
      for (const at of sh.keys) assert.ok(at >= sh.typing && at < sh.searched, `search ${k + 1}: a key at ${at}s`);
    });
    assert.ok(tl.lines.every((l) => l.at >= 0 && l.at < tl.duration));
  });

  test(`${fmt.name}: motion blur takes between one and eleven samples`, () => {
    const film = new F.Film(key, F.facts());
    for (let t = 0; t < e.duration; t += 0.05) {
      const n = film.samples(t);
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 11, `${n} at ${t.toFixed(2)}s`);
    }
  });

  test(`${fmt.name}: the product photographs are frames of the phone session's live results`, () => {
    const phone = F.FORMATS.mobile.searches;
    F.PHOTOS.forEach((p, k) => {
      assert.ok(p.f >= phone[k].liveFrom - 0.01 && p.f < phone[k].click, `photo ${k + 1} at ${p.f}s`);
      const r = F.insetRect(p.rect, p.inset);
      assert.ok(Math.abs(r.w / r.h - p.rect.w / p.rect.h) < 1e-9, 'the inset keeps the tile\'s shape');
    });
  });
}

if (process.env.FILM_SKIP_DRAW !== '1') {
  test('a drawn frame is the film\'s size and has something in it', async () => {
    const film = new F.Film('desktop', F.facts());
    film.prepare();
    const t = film.edit.shots[0].liveStart + 0.8;
    const buf = await film.frame(t);
    assert.strictEqual(buf.length, film.fmt.W * film.fmt.H * 4);
    let dark = 0;
    for (let i = 0; i < buf.length; i += 4 * 97) if (buf[i] < 128) dark += 1;
    assert.ok(dark > 200, 'the results frame is blank');
  });
}

(async () => {
  console.log('\nthe film');
  for (const run of queue) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
