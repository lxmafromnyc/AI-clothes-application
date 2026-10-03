/* =========================================================
   Fynd demo recorder — opening a product at its retailer

   One step of scripts/record-demo.js, kept on its own so it can be tested
   on its own (scripts/test-retailer-visit.js): a product card is clicked,
   and whatever the browser really does next is what happens.

   Three outcomes, never more than a few seconds each, so one slow shop can
   never hold up the next product:

     A  'loaded'  a new tab opened and its page reached domcontentloaded
                  within LIMITS.dom. The tab is kept for a short look
                  (holdMs) and then closed.
     B  'slow'    a new tab opened, but its page did not reach
                  domcontentloaded in time. Nothing more is waited for:
                  the tab is closed and the visit is reported slow, with
                  the address it was opening. A page that reached the DOM
                  but is plainly a bot check is reported 'blocked' and
                  treated the same way — a block page is not the shop.
     C  'no-tab'  the click opened no new tab within LIMITS.tab. Reported
                  as such; there is no tab to show.

   Whatever the outcome, the Fynd tab is brought back to the front and the
   caller carries on. Nothing here ever draws, fakes or substitutes a
   retailer page: the caller decides what to show from the outcome, and
   only an 'loaded' tab is ever shown.
   ========================================================= */

'use strict';

/* each limit on its own, so no single wait can block the whole run */
const LIMITS = {
  tab: 3000,      /* the click → a new tab exists */
  dom: 5000,      /* the new tab → domcontentloaded */
  holdMin: 2000,  /* a loaded page is looked at for 2–3 seconds */
  holdMax: 3000
};

const BLOCKED = /access denied|forbidden|captcha|just a moment|attention required|are you a robot|pardon our interruption|request unsuccessful|blocked/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\d?\./, ''); } catch (err) { return ''; }
}

/*  context   the Playwright BrowserContext the Fynd page lives in
    page      the Fynd page
    click     async () => performs the real click on the real card
    href      the card's own link, read from the card before the click
    holdMs    how long a loaded page is looked at
    onLoaded  async (tab) => called once a page is loaded, before the
              hold — the recorder uses it to name the shop in the strip
    limits    overrides LIMITS (tests)
    log       where slow, blocked and failed visits are reported

   The new tab is noticed the moment the browser creates it, from the
   browser's own target events. Playwright only hands over a Page once
   the tab has committed its first navigation, which for a slow shop is
   seconds later and for one that never answers is never — waiting for
   that would turn a slow shop into "no tab", and its late arrival would
   be mistaken for the next product's tab. Here each visit knows its own
   tab by id, and closes it by id if Playwright never gets a Page for it. */
async function visitRetailer({ context, page, click, href, holdMs, onLoaded, limits, log = console.log }) {
  const lim = { ...LIMITS, ...(limits || {}) };
  const hold = holdMs == null ? (lim.holdMin + lim.holdMax) / 2 : holdMs;
  const host = hostOf(href);
  const visit = { kind: 'no-tab', href, host, url: null, clickedAt: null, openedAt: null, pageAt: null, domAt: null, closedAt: null, video: null };

  const browser = context.browser();
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const before = new Set(targetInfos.map((t) => t.targetId));

  let created = null;
  let announce;
  const appeared = new Promise((r) => { announce = r; });
  const onCreated = ({ targetInfo }) => {
    if (created || targetInfo.type !== 'page' || before.has(targetInfo.targetId)) return;
    created = targetInfo;
    announce(targetInfo);
  };
  cdp.on('Target.targetCreated', onCreated);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  /* the Playwright Page for THIS tab, if it ever gets one */
  const known = new Set(context.pages());
  let tab = null;
  const onPage = async (p) => {
    if (known.has(p) || tab) return;
    known.add(p);
    if (!created) return;
    const s = await context.newCDPSession(p).catch(() => null);
    const info = s && await s.send('Target.getTargetInfo').catch(() => null);
    if (s) s.detach().catch(() => {});
    if (info && info.targetInfo.targetId === created.targetId) { tab = p; visit.pageAt = Date.now(); }
  };
  context.on('page', onPage);
  const cleanup = async () => {
    context.off('page', onPage);
    cdp.off('Target.targetCreated', onCreated);
    await cdp.send('Target.setDiscoverTargets', { discover: false }).catch(() => {});
    await cdp.detach().catch(() => {});
    await page.bringToFront().catch(() => {});
  };

  visit.clickedAt = Date.now();
  try {
    await click();
  } catch (err) {
    log(`  click on ${host || href} failed: ${err && err.message}`);
  }
  const target = await Promise.race([appeared, sleep(lim.tab).then(() => null)]);

  if (!target) {
    log(`  ${host || href}: the click opened no new tab within ${lim.tab / 1000}s — nothing to show; carrying on`);
    visit.closedAt = Date.now();
    await cleanup();
    return visit;
  }

  visit.openedAt = Date.now();
  const deadline = visit.openedAt + lim.dom;
  /* a page that was already open when the event fired */
  if (!tab) for (const p of context.pages()) await onPage(p);
  while (!tab && Date.now() < deadline) await sleep(40);

  let loaded = false;
  if (tab) {
    visit.video = tab.video ? tab.video() : null;
    try {
      await tab.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) });
      /* about:blank reaches the DOM too; only the shop's own page counts */
      loaded = /^https?:/i.test(tab.url());
    } catch (err) {
      loaded = false;
    }
  }
  visit.url = tab ? tab.url() : (created.url || href);

  if (loaded) {
    visit.domAt = Date.now();
    const title = await tab.title().catch(() => '');
    if (BLOCKED.test(title)) {
      visit.kind = 'blocked';
      log(`  ${host}: the page that opened is a bot check ("${title.slice(0, 60)}") — not shown; carrying on`);
    } else {
      visit.kind = 'loaded';
      if (onLoaded) await onLoaded(tab).catch(() => {});
      await sleep(hold);
    }
  } else {
    visit.kind = 'slow';
    log(`  ${host || visit.url}: a new tab opened but the page did not reach domcontentloaded within ${lim.dom / 1000}s — slow; carrying on`);
  }

  if (tab) await tab.close({ runBeforeUnload: false }).catch(() => {});
  else await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
  visit.closedAt = Date.now();
  await cleanup();
  return visit;
}

module.exports = { visitRetailer, LIMITS, hostOf };
