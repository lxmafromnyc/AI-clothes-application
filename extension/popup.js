/* =========================================================
   Fynd extension — the popup

   Nothing happens until "Check sizing with Fynd" is pressed. Then:

     1  the active tab: only an http(s) page can be read; anything else
        (chrome:// pages, the Web Store, a PDF viewer) says so
     2  fyndCollect (collect.js) runs once in that page, under the
        activeTab grant the press gave, and returns plain text only
     3  FyndPayload.candidates ranks the size tables it found, labelled
        the way Fynd's server labels them (assets/sizing-tables.js). One
        clear chart is shown; several that could each be it are offered
        to the shopper to choose — never picked silently
     4  the chart is drawn by Fynd's own renderer (assets/size-chart.js):
        values, units and what it measures as the page gave them, read
        from the browser and not checked by Fynd
     5  "Open in Fynd" opens Find Fit with the chart in the address
        fragment (#fynd-chart=…), which stays in the browser; with no
        chart, with the page's address (#fynd-url=…), so Find Fit can
        look in Fynd's catalog of checked charts

   The popup makes no network request of its own.

   For tests only, ?tab=<id> names the tab to read: it reaches nothing
   the extension isn't already allowed to read, since without a press
   on the toolbar button that is nothing at all.
   ========================================================= */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { candidates, build, validate, encode, toChart } = window.FyndPayload;
  const { render, headingFor, safeLink, el } = window.SizeChart;
  const SECTIONS = ['start', 'busy', 'problem', 'choose', 'result'];

  let collected = null;
  let found = null;
  let payload = null;

  function show(id) {
    SECTIONS.forEach((s) => { $(s).hidden = s !== id; });
    document.body.dataset.state = id;
  }

  function problem(title, text) {
    $('problem-title').textContent = title;
    $('problem-text').textContent = text;
    show('problem');
  }

  async function activeTab() {
    const named = Number(new URLSearchParams(location.search).get('tab'));
    if (named) return chrome.tabs.get(named);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function check() {
    show('busy');
    let tab;
    try { tab = await activeTab(); } catch (err) { tab = null; }
    if (!tab) { problem('No page to read', 'Open a clothing product page in this window, then try again.'); return; }
    if (tab.url && !/^https?:\/\//i.test(tab.url)) {
      problem('Fynd can’t read this page', 'Fynd reads ordinary web pages (http or https). Open a clothing product page on a retailer’s site, then try again.');
      return;
    }
    let results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fyndCollect });
    } catch (err) {
      problem('Fynd can’t read this page', 'Chrome doesn’t let extensions read this page. Open a clothing product page on a retailer’s site, then try again.');
      return;
    }
    collected = results && results[0] && results[0].result;
    if (!collected || typeof collected !== 'object') {
      problem('Fynd couldn’t read this page', 'The page didn’t give anything Fynd could read. Reload it, then try again.');
      return;
    }
    found = candidates(collected);
    if (!found.list.length) { finish(null); return; }
    if (found.confident) { finish(0); return; }
    choose();
  }

  /* several tables could each be the chart: the shopper says which,
     each saying what it measures, as its own words do */
  const MEASURES_SHORT = { 'finished-garment': 'Garment measurements', body: 'Body measurements', 'not-stated': 'Body or garment not stated' };
  function choose() {
    $('choose-text').textContent = `This page has ${found.list.length} tables that look like size charts. Choose the one for this product.`;
    const list = $('choices');
    list.replaceChildren();
    found.list.forEach((c, i) => {
      const b = el('button', 'pop-choice');
      b.type = 'button';
      b.append(el('span', 'pop-choice-name', c.heading || c.chart.title || `Table ${i + 1}`),
        el('span', 'pop-choice-cols', `${MEASURES_SHORT[c.chart.measures]} · ${c.chart.rows.length} sizes · ${c.chart.columns.join(', ')}${c.inDialog ? ' · in the open size guide' : c.visible ? '' : ' · not in view'}`));
      b.addEventListener('click', () => finish(i));
      const li = el('li');
      li.append(b);
      list.append(li);
    });
    show('choose');
  }

  function finish(pick) {
    const checked = validate(build(collected, pick));
    if (checked.error) {
      problem('Fynd couldn’t read this chart', 'The table on this page didn’t read as a size chart Fynd can show. Open the product page’s size guide and try again.');
      return;
    }
    payload = checked.payload;
    const chart = toChart(payload);
    $('result-title').textContent = headingFor(chart);
    const product = $('result-product');
    product.replaceChildren(safeLink(payload.page.url, 'View product'), el('span', 'pop-host', ` · ${new URL(payload.page.url).hostname.replace(/^www\./, '')}`));
    $('result-body').replaceChildren(...render(chart, payload.page.url, { linked: true }));
    $('other').hidden = !(found && found.list.length > 1);
    const hasChart = Boolean(payload.chart || payload.sizes.length);
    $('open-fynd').textContent = hasChart ? 'Open in Fynd' : 'Check Fynd’s catalog';
    $('open-note').textContent = hasChart
      ? 'Opens Find Fit with this chart. Only the chart and the product’s address go with it, in the link itself.'
      : 'Opens Find Fit with this product’s address, to look for a chart Fynd has checked.';
    document.body.dataset.result = chart.status;
    show('result');
  }

  function openInFynd() {
    if (!payload) return;
    const base = `${FYND_SITE.replace(/\/$/, '')}/index.html`;
    const url = payload.chart || payload.sizes.length
      ? `${base}#fynd-chart=${encode(payload)}`
      : `${base}#fynd-url=${encodeURIComponent(payload.page.url)}`;
    chrome.tabs.create({ url });
  }

  $('check').addEventListener('click', check);
  $('retry').addEventListener('click', check);
  $('again').addEventListener('click', check);
  $('other-button').addEventListener('click', choose);
  $('open-fynd').addEventListener('click', openInFynd);
  show('start');
})();
